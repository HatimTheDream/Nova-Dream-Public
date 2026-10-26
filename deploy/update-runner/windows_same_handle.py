"""Read-only same-handle evidence primitive; no import-time native effects.

No CLI or default port exists. An independently reviewed caller must provide the
exact path, bind its owned process/ancestor custody and explicitly create Win32.
This primitive does not authenticate a caller, derive inherited ACLs, authorize
execution, or translate a Node fd into a presumed Windows handle.
"""
import base64
import copy
import ctypes
import re
from pathlib import PureWindowsPath

DWORD = ctypes.c_uint32
BOOL = ctypes.c_int32
HANDLE = ctypes.c_void_p
ULONG64 = ctypes.c_uint64


def need(value, reason):
    if not value:
        raise ValueError(reason)


def canonical_path(path):
    need(type(path) is str and 3 < len(path) <= 4096 and "\0" not in path,
         "bounded-path-required")
    p = PureWindowsPath(path)
    need(re.fullmatch(r"[A-Za-z]:", p.drive) and p.is_absolute() and str(p) == path,
         "canonical-drive-path-required")
    for part in p.parts[1:]:
        need(part not in (".", "..") and not part.endswith((" ", ".")) and
             not any(c in part for c in '<>:"/\\|?*') and
             not any(ord(c) < 32 for c in part) and
             not re.fullmatch(r"(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?",
                              part, flags=re.I), "ordinary-path-component-required")
    return path


class CaptureFailure(RuntimeError):
    def __init__(self, phase, observations, original, close_error=None):
        super().__init__("same-handle-capture-refused:" + phase)
        self.phase = phase
        self.observations = copy.deepcopy(observations)
        self.original_type = type(original).__name__
        self.original_message = str(original)[:2048]
        self.original_code = original.args[0] if isinstance(original, OSError) and original.args and type(original.args[0]) is int else None
        self.close_error = None if close_error is None else {
            "type": type(close_error).__name__, "message": str(close_error)[:2048],
            "code": close_error.args[0] if isinstance(close_error, OSError) and close_error.args and type(close_error.args[0]) is int else None}


INFO_FIELDS = frozenset(("volumeSerial32", "fileIndex64", "volumeSerial64",
    "fileId128Hex", "attributes", "reparseTag", "links", "directory",
    "deletePending", "size", "allocationBytes", "creation100ns",
    "access100ns", "write100ns", "change100ns"))


def checked_info(value, kind):
    need(type(value) is dict and set(value) == INFO_FIELDS, "complete-handle-info-required")
    integers = INFO_FIELDS - {"fileId128Hex", "directory", "deletePending"}
    need(all(type(value[k]) is int and value[k] >= 0 for k in integers),
         "nonnegative-handle-integers-required")
    need(type(value["directory"]) is bool and type(value["deletePending"]) is bool,
         "literal-handle-booleans-required")
    need(value["volumeSerial32"] <= 0xffffffff and value["volumeSerial64"] <= 0xffffffffffffffff
         and 0 < value["fileIndex64"] <= 0xffffffffffffffff, "bounded-handle-identity-required")
    need(all(value[k] <= 0xffffffff for k in ("attributes", "reparseTag", "links")) and
         all(value[k] <= 0x7fffffffffffffff for k in ("size", "allocationBytes", "creation100ns",
             "access100ns", "write100ns", "change100ns")), "native-width-bounds-required")
    need(type(value["fileId128Hex"]) is str and
         re.fullmatch(r"[0-9a-f]{32}", value["fileId128Hex"]) and
         value["fileId128Hex"] != "0" * 32, "complete-file-id-required")
    need(not value["attributes"] & 0x400 and value["reparseTag"] == 0,
         "reparse-object-refused")
    need(not value["deletePending"] and value["directory"] == (kind == "directory")
         and bool(value["attributes"] & 0x10) == value["directory"], "ordinary-kind-required")
    need(value["links"] >= 1 and (kind == "directory" or value["links"] == 1),
         "single-link-file-required")
    return value


def checked_security(raw):
    need(type(raw) is bytes and 20 <= len(raw) <= 65536, "bounded-raw-security-required")
    return raw


def capture(path, kind, port):
    """Read twice from one handle; close exactly once, retain failures, never retry.

    Port methods are open(path), info(handle), security(handle), close(handle).
    Tests inject synthetic ports. Real capture additionally needs a reviewed plan.
    """
    canonical_path(path)
    need(kind in ("file", "directory"), "ordinary-kind-required")
    handle = None
    phase = "open"
    observed = {}
    error = close_error = None
    try:
        handle = port.open(path)
        need(type(handle) is int and 0 < handle < ctypes.c_void_p(-1).value,
             "valid-owned-handle-required")
        phase = "information-before"
        observed["before"] = copy.deepcopy(port.info(handle))
        checked_info(observed["before"], kind)
        phase = "security-before"
        first = port.security(handle)
        observed["securityBeforeBase64"] = base64.b64encode(checked_security(first)).decode("ascii")
        phase = "security-after"
        second = port.security(handle)
        observed["securityAfterBase64"] = base64.b64encode(checked_security(second)).decode("ascii")
        need(first == second, "security-changed-during-capture")
        phase = "information-after"
        observed["after"] = copy.deepcopy(port.info(handle))
        checked_info(observed["after"], kind)
        need(observed["before"] == observed["after"], "handle-information-changed-during-capture")
    except BaseException as exc:
        error = exc
    finally:
        if type(handle) is int and 0 < handle < ctypes.c_void_p(-1).value:
            try:
                port.close(handle)
                observed["handleClosed"] = True
            except BaseException as exc:
                close_error = exc
                observed["handleClosed"] = False
        observed["apiEvents"] = copy.deepcopy(getattr(port, "events", []))
    if error is not None or close_error is not None:
        raise CaptureFailure(phase if error is not None else "close", observed,
                             error if error is not None else close_error, close_error) from error
    return {"format": 1, "path": path, "kind": kind, "information": observed["before"],
            "ownerGroupDaclBase64": observed["securityBeforeBase64"], "saclNotRequested": True,
            "sameHandleStable": True, "handleClosed": True,
            "pathCustodyVerified": False, "inheritedSecurityDerived": False,
            "nativeExecutionAdmitted": False, "observations": observed}


class FileTime(ctypes.Structure):
    _fields_ = [("low", DWORD), ("high", DWORD)]


class ByHandleInfo(ctypes.Structure):
    _fields_ = [("attributes", DWORD), ("creation", FileTime), ("access", FileTime),
                ("write", FileTime), ("volume", DWORD), ("sizeHigh", DWORD),
                ("sizeLow", DWORD), ("links", DWORD), ("indexHigh", DWORD), ("indexLow", DWORD)]


class BasicInfo(ctypes.Structure):
    _fields_ = [("creation", ctypes.c_int64), ("access", ctypes.c_int64),
                ("write", ctypes.c_int64), ("change", ctypes.c_int64), ("attributes", DWORD)]


class StandardInfo(ctypes.Structure):
    _fields_ = [("allocation", ctypes.c_int64), ("size", ctypes.c_int64), ("links", DWORD),
                ("deletePending", ctypes.c_ubyte), ("directory", ctypes.c_ubyte)]


class AttributeTagInfo(ctypes.Structure):
    _fields_ = [("attributes", DWORD), ("tag", DWORD)]


class IdInfo(ctypes.Structure):
    _fields_ = [("volume", ULONG64), ("identifier", ctypes.c_ubyte * 16)]


class Win32:
    """Only explicit construction loads system DLLs. No permission-setting APIs."""
    def __init__(self):
        import os
        need(os.name == "nt", "windows-required")
        self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.s = ctypes.WinDLL("advapi32", use_last_error=True)
        self.events = []
        self.last_error = 0
        signatures = [
            (self.k.CreateFileW, [ctypes.c_wchar_p, DWORD, DWORD, ctypes.c_void_p,
                                  DWORD, DWORD, HANDLE], HANDLE),
            (self.k.GetDriveTypeW, [ctypes.c_wchar_p], DWORD),
            (self.k.GetFileType, [HANDLE], DWORD),
            (self.k.GetFileInformationByHandle, [HANDLE, ctypes.POINTER(ByHandleInfo)], BOOL),
            (self.k.GetFileInformationByHandleEx, [HANDLE, ctypes.c_int32, ctypes.c_void_p, DWORD], BOOL),
            (self.k.CloseHandle, [HANDLE], BOOL),
            (self.s.GetKernelObjectSecurity, [HANDLE, DWORD, ctypes.c_void_p, DWORD, ctypes.POINTER(DWORD)], BOOL),
            (self.s.IsValidSecurityDescriptor, [ctypes.c_void_p], BOOL),
            (self.s.GetSecurityDescriptorLength, [ctypes.c_void_p], DWORD)]
        for function, arguments, result in signatures:
            function.argtypes = arguments
            function.restype = result

    def call(self, name, function, arguments, description, raw=None):
        # A bounded log records every actual result, including failed calls and
        # incomplete output buffers. It is private evidence, not an admission.
        need(len(self.events) < (64 if name == "CloseHandle" else 63), "native-call-budget-exhausted")
        event = {"sequence": len(self.events), "api": name, "arguments": description}
        self.events.append(event)
        ctypes.set_last_error(0)
        try:
            result = function(*arguments)
            self.last_error = ctypes.get_last_error()
            event.update(result=result, lastError=self.last_error)
            if raw is not None:
                event["raw"] = raw()
            return result
        except BaseException as exc:
            event["exception"] = {"type": type(exc).__name__, "message": str(exc)[:2048]}
            raise

    @staticmethod
    def raw_structure(value):
        return {"bytes": ctypes.sizeof(value), "base64": base64.b64encode(bytes(value)).decode("ascii")}

    def require(self, ok, phase):
        if not ok:
            raise OSError(self.last_error, phase)

    def open(self, path):
        canonical_path(path)
        need(not self.events, "one-capture-per-native-port")
        anchor = PureWindowsPath(path).anchor
        need(self.call("GetDriveTypeW", self.k.GetDriveTypeW, (anchor,), {"root": anchor}) == 3,
             "fixed-drive-required")
        # READ_CONTROL | FILE_READ_ATTRIBUTES, share read/write/delete,
        # OPEN_EXISTING, OPEN_REPARSE_POINT | BACKUP_SEMANTICS, no inheritance.
        handle = self.call("CreateFileW", self.k.CreateFileW,
                          (path, 0x20080, 7, None, 3, 0x02200000, None),
                          {"path": path, "access": 0x20080, "share": 7, "security": None,
                           "disposition": 3, "flags": 0x02200000, "template": None})
        self.require(handle not in (None, ctypes.c_void_p(-1).value), "CreateFileW")
        return handle

    def info(self, handle):
        need(self.call("GetFileType", self.k.GetFileType, (handle,), {"handle": handle}) == 1,
             "disk-file-handle-required")
        legacy = ByHandleInfo()
        self.require(self.call("GetFileInformationByHandle", self.k.GetFileInformationByHandle,
                     (handle, ctypes.byref(legacy)), {"handle": handle},
                     lambda: self.raw_structure(legacy)),
                     "GetFileInformationByHandle")
        values = []
        for code, shape in ((0, BasicInfo), (1, StandardInfo), (9, AttributeTagInfo), (18, IdInfo)):
            value = shape()
            self.require(self.call("GetFileInformationByHandleEx", self.k.GetFileInformationByHandleEx,
                         (handle, code, ctypes.byref(value), ctypes.sizeof(value)),
                         {"handle": handle, "class": code, "bytes": ctypes.sizeof(value)},
                         lambda: self.raw_structure(value)),
                         "GetFileInformationByHandleEx:" + str(code))
            values.append(value)
        basic, standard, tag, identity = values
        need(legacy.attributes == basic.attributes == tag.attributes and legacy.links == standard.links
             and ((legacy.sizeHigh << 32) | legacy.sizeLow) == standard.size,
             "cross-api-information-changed")
        for old, new in ((legacy.creation, basic.creation), (legacy.access, basic.access),
                         (legacy.write, basic.write)):
            need(((old.high << 32) | old.low) == new, "cross-api-times-changed")
        need(standard.deletePending in (0, 1) and standard.directory in (0, 1),
             "literal-native-booleans-required")
        return {"volumeSerial32": legacy.volume,
                "fileIndex64": (legacy.indexHigh << 32) | legacy.indexLow,
                "volumeSerial64": identity.volume, "fileId128Hex": bytes(identity.identifier).hex(),
                "attributes": basic.attributes, "reparseTag": tag.tag, "links": standard.links,
                "directory": bool(standard.directory), "deletePending": bool(standard.deletePending),
                "size": standard.size, "allocationBytes": standard.allocation,
                "creation100ns": basic.creation, "access100ns": basic.access,
                "write100ns": basic.write, "change100ns": basic.change}

    def security(self, handle):
        required = DWORD()
        first = self.call("GetKernelObjectSecurity:size", self.s.GetKernelObjectSecurity,
                          (handle, 7, None, 0, ctypes.byref(required)),
                          {"handle": handle, "requested": 7, "allocated": 0},
                          lambda: {"required": required.value})
        need(not first and self.last_error == 122 and 20 <= required.value <= 65536,
             "bounded-security-size-required")
        allocated = required.value
        buffer = ctypes.create_string_buffer(allocated)
        self.require(self.call("GetKernelObjectSecurity:read", self.s.GetKernelObjectSecurity,
                     (handle, 7, buffer, allocated, ctypes.byref(required)),
                     {"handle": handle, "requested": 7, "allocated": allocated},
                     lambda: {"required": required.value, "allocatedBytesBase64": base64.b64encode(buffer.raw).decode("ascii")}),
                     "GetKernelObjectSecurity")
        need(20 <= required.value <= allocated, "security-size-changed")
        need(self.call("IsValidSecurityDescriptor", self.s.IsValidSecurityDescriptor, (buffer,),
                       {"allocated": allocated}), "invalid-native-security-descriptor")
        need(self.call("GetSecurityDescriptorLength", self.s.GetSecurityDescriptorLength, (buffer,),
                       {"allocated": allocated}) == required.value, "security-length-mismatch")
        return bytes(buffer.raw[:required.value])

    def close(self, handle):
        self.require(self.call("CloseHandle", self.k.CloseHandle, (handle,), {"handle": handle}), "CloseHandle")
