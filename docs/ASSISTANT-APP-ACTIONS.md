# Assistant app controls

Assistant uses the same saved records and service commands as the app. Ask it to
discover `nova_read` → `catalog` before concluding an app action is unavailable.
The catalog returns the exact schema for each operation; `actions.read` returns
the saved outcome. A pending review, queued window request or running agent job
does not mean its requested work finished.

Examples include “move all Chat conversations to Deleted,” “restore my archived
work,” “change the theme to dark,” “make message text larger,” “open Calendar,”
“save this note in my Library,” “put this agent to sleep,” and “review this Content
draft.” Shared theme, icon, timezone, navigation and Home controls use
`settings.read` / `settings.save`. Fonts and text size use `app.appearance` on the
requesting device. Conversation settings include title, organization, model and
thinking preferences, with exact current revisions.

Changes follow the conversation's Access setting. Read-only, Plan and Research
requests cannot make workspace edits. Guarded changes and catalog operations
marked for review use the existing Apply/Cancel card. Account sign-in, access
grants, pairing, native security approvals and workspace recovery keep their
dedicated authenticated controls; the Assistant can open the appropriate
Settings category without granting itself permission.

Deleting a chat normally means moving it to the reversible Deleted area. Bulk
actions freeze their exact Chat/Work scope and target revisions before review.
Apply after the reply finishes to include its own chat; active calls or changed
targets stay protected and are reported individually. Unsent drafts survive.
Permanent removal is a separate reviewed operation on an already-deleted,
settled chat, using its original native identity and removal journal. It cannot
permanently remove the chat currently issuing the tool call.

Window actions require the original device's visible Assistant window, current
permission and an exclusive browser lock. Unsaved-writing guards still apply.
They expire after two minutes rather than unexpectedly navigating a later visit.
A lost acknowledgement checks the original saved outcome without repeating the
window effect. Asynchronous Content, meeting and assignment actions observe their
original job identities and never start replacement work while status is unknown.

New controls extend the central ModuleActions catalog with explicit schemas and
canonical service methods. Do not expose arbitrary HTTP calls, raw storage or
authority fields as model arguments. Aggregate Home and conversation controls
belong to the owner Assistant; scoped assignments retain the intersection of
their captured and current module capabilities.
