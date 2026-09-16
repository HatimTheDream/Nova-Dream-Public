# Predecessor import preparation

Use Settings → Import saved work. Import reviews and separate workspace copies do not replace the predecessor or the current Edition 3 workspace. Connected effects remain paused. The current adapters cover compatible local Tasks, Projects, Contacts and Content; other records remain in the encrypted source archive with an explicit review entry. This is not a complete migration of all predecessor behavior.

## Nova Dream schema 15

Select the predecessor's existing `.nova-backup`, then its matching `.backup.key`. Use the original backup folder and a verified backup created by the predecessor's supported backup command. The browser authenticates and decrypts the backup locally. The key is never uploaded. Select the source timezone, and keep the source workspace UUID for later exports from that same workspace. Use a different UUID for a different source workspace.

The supported table snapshot comes from `NovaBackups.capture` and `FieldCipher` at fixed source `04138bc1f925691f697eada335bd7a763ed91ec5`. No installed app, runtime lease, native session file or database is rewritten to prepare the review. A lost key or unsupported schema is a blocker; do not invent a replacement key.

## Dream Claw 0.57.2

`prepareDreamClawExport` in `dream-claw-export.mjs` reads the allowlisted storage fields from the original application's browser context and returns the prepared JSON object. Provide the verified application version, source timezone and a stable source-workspace UUID. Save that result as a private JSON file for the import review. Run the helper through the permitted browser-control surface when operating for the owner. Do not enumerate or export the whole browser storage, since it can contain unrelated credentials.

The actual Workshop v3, Mission Control v0 and Home layout v2 formats are grounded in fixed source `e0769bd9f8fdd50d0772ae8e188c0be7bf1c7f1b`. Browser storage is only one source: inventory native files, finance archives and original Assistant history separately. Do not call this export a complete predecessor backup.

## Review and rehearsal

Check editable and preserved records, dependency/Project problems, date conversions, duplicate task candidates and earlier XP. Original source bytes/fields remain archived; an unsupported record is not silently discarded. Preparation creates a new encrypted workspace with a new recovery epoch. Open it from Backup & recovery, test linked work and editing, then return to the original. Keep source and destination digests and actual device/build evidence. Real cutover, native resumption and installed rollback require their separate acceptance.
