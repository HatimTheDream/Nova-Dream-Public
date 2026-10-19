"""Bound temporary CI artifact storage before upload; never uploads or deletes files."""
import argparse
import glob
import json
import os
import pathlib
import stat

MAXIMUM_BYTES = 16 * 1024 * 1024
MAXIMUM_FILES = 4096


def inspect(paths, maximum_bytes=MAXIMUM_BYTES, maximum_files=MAXIMUM_FILES, allow_empty=False):
    if type(maximum_bytes) is not int or not 1 <= maximum_bytes <= MAXIMUM_BYTES:
        raise RuntimeError('artifact-byte-budget-invalid')
    if type(maximum_files) is not int or not 1 <= maximum_files <= MAXIMUM_FILES:
        raise RuntimeError('artifact-file-budget-invalid')
    if not paths or len(paths) > 32:
        raise RuntimeError('artifact-path-list-invalid')
    seen, total = set(), 0

    def check_ancestors(path):
        for part in (path, *path.parents):
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise RuntimeError('artifact-symlink-refused')

    def add(path):
        nonlocal total
        check_ancestors(path)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError('artifact-nonregular-file-refused')
        identity = os.path.normcase(str(path.absolute()))
        if identity in seen:
            return
        seen.add(identity)
        total += info.st_size
        if len(seen) > maximum_files:
            raise RuntimeError('artifact-file-budget-exceeded')
        if total > maximum_bytes:
            raise RuntimeError('artifact-byte-budget-exceeded')

    for raw in paths:
        if not isinstance(raw, str) or not raw or len(raw) > 4096:
            raise RuntimeError('artifact-path-invalid')
        # Workflow directory/** means the whole directory. Other recursive
        # patterns are refused rather than following symlink directory trees.
        pattern = raw[:-3] if raw.endswith('/**') else raw
        if '**' in pattern:
            raise RuntimeError('artifact-recursive-pattern-refused')
        matches = glob.iglob(pattern, recursive=False) if glob.has_magic(pattern) else [pattern]
        matched = False
        for match in matches:
            path = pathlib.Path(match).absolute()
            if not path.exists() and not path.is_symlink():
                continue
            matched = True
            check_ancestors(path)
            if path.is_dir():
                for folder, directories, files in os.walk(path, followlinks=False):
                    for directory in directories:
                        check_ancestors(pathlib.Path(folder) / directory)
                    for filename in files:
                        add(pathlib.Path(folder) / filename)
            else:
                add(path)
        if not matched and not allow_empty:
            raise RuntimeError('artifact-input-missing')
    if not seen and not allow_empty:
        raise RuntimeError('artifact-input-empty')
    return {'format': 1, 'files': len(seen), 'bytes': total,
            'maximumFiles': maximum_files, 'maximumBytes': maximum_bytes,
            'withinBudget': True, 'uploaded': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--path', action='append', required=True)
    parser.add_argument('--maximum-bytes', type=int, default=MAXIMUM_BYTES)
    parser.add_argument('--maximum-files', type=int, default=MAXIMUM_FILES)
    parser.add_argument('--allow-empty', action='store_true')
    args = parser.parse_args()
    try:
        result = inspect(args.path, args.maximum_bytes, args.maximum_files, args.allow_empty)
    except (OSError, RuntimeError) as error:
        code = str(error) if isinstance(error, RuntimeError) else 'artifact-input-unreadable'
        print(json.dumps({'withinBudget': False, 'reason': code, 'uploaded': False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
