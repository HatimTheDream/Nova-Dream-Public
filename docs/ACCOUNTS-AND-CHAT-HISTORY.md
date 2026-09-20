# Accounts And Chat History

Nova keeps your conversations and saved work. Connected ChatGPT accounts provide model access; they do not own or lock a Nova chat.

## Connect And Choose Accounts

In Settings → Assistant → ChatGPT Accounts, choose **Add Account** for another connection or **Reconnect** beside an existing one. Adding an account preserves the existing connection. Set the preferred account and backup order there. The selector above a conversation's composer can use that default order or prefer a particular account.

Settings → Usage shows each account's own reported allowance and reset time. Unknown usage stays unknown. A failed refresh keeps the previous reading labelled as last known. Duplicate connections to the same identity share an allowance and are not independent backups.

Before starting a new reply, Nova selects a ready account using the preference, current cooldowns and available usage readings. The conversation and its context stay intact. Account order cannot change during unsettled work or an active call. An uncertain request is kept for reconciliation; Nova never resends it automatically through another account.

Realtime audio follows the host's shared account order. The per-chat preference selects the backing text brain. Mid-call account switching is not supported; end and reconnect the call when necessary. Saved captions remain in the conversation.

## Saved History And Recovery

Saved messages, partial replies, captions, pins and verified file contents remain readable without a connected ChatGPT account. Older history is captured in bounded background pages when its original Assistant is available. A partial archive is labelled; Nova cannot recover messages or file bytes it never received.

If a settled Chat conversation needs a replacement Assistant connection, **Resume Chat** keeps the same visible conversation and draft. Review the saved coverage, then connect it. Its next message includes the frozen dialogue and available files as historical reference. Old requests, tool actions and approvals are not replayed. The new connection starts read-only; memory and the current Project are still supplied normally.

Unconfirmed setup is checked against the original prepared connection identity. Missing files, conflicting history, active or uncertain replies, and queued messages must be resolved first. Work conversations keep their verified checkout requirements. The current message limits also apply to carried history and files.

Workspace backups include the Nova archive and saved files. Existing native archives remain preserved separately. A saved copy is not evidence that every older message has been captured or that a copied native runtime can execute from another host.
