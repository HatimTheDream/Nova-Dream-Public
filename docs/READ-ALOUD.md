# Reading completed replies

Read aloud prepares Markdown as speech, keeps meaningful sentence boundaries, chooses a suitable device voice by language when needed, and limits provider look-ahead to one chunk. A separately scoped, on-demand connection uses the already configured speech provider; it does not reconfigure live voice chat or change ordinary Assistant permissions.

The player reports preparation until audio actually starts. Pause, resume, playback failure and completion follow audio events. Stop and navigation invalidate pending callbacks and release audio objects, so a late response cannot resume an old reply. An already dispatched synthesis request cannot be cancelled through the current gateway contract; its returned audio is discarded after Stop. No automatic repeat is sent after an uncertain synthesis result.

Provider availability and read/talk authority are checked before playback. Missing or denied speech support offers **Use device voice** explicitly. This fallback restarts the reply and may still sound less natural than a configured neural voice. It is not presented as equivalent quality.

Prepared audio is bounded and validates its format, base64 encoding and container header before the browser attempts decoding. Recent request identities are retained independently of cached audio, allowing long replies without repeated synthesis of an evicted request.

Automated coverage checks chunking, text preparation, scope isolation, connection changes, cancellation, stale callbacks, pause/resume, autoplay refusal, malformed audio and uncertain request recovery. Actual sound quality and physical-phone playback require listening acceptance with the configured provider.
