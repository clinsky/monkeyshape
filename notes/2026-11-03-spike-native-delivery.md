# Spike: native notices into an idle Claude Code session

2026-11-03, bead `monkeyshape-f4y.9`, Claude Code 2.1.317 on Linux. Question: can an
`mshape` process push one notice line into a running Claude Code session, including an idle
one, so that the agent sees it with no prompt from the human?

**Answer: yes.** Delivery is reliable in every case tried; the format is undocumented, so
`f4y.10` builds it as a versioned internal behind the `Notifier`.

## What the session publishes

- Each interactive session listens on a Unix socket, `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`
  (falling back to `/tmp/cc-socks-<uid>/<pid>.sock`), and exports it to its own processes as
  `CLAUDE_CODE_MESSAGING_SOCKET`, with `CLAUDE_CODE_MESSAGING_TOKEN` and
  `CLAUDE_CODE_SESSION_ID`.
- `~/.claude/sessions/<pid>.json` describes it: `sessionId`, `cwd`, `messagingSocketPath`,
  `peerProtocol` (1 here), `peerFeatures` (includes `notify_idle`), `status` (`busy` or
  idle), `procStart` (tells a reused pid apart) and `updatedAt`. Stale files linger.
- Beside it, `~/.claude/sessions/<pid>.<hash>.key` (mode 0600) is JSON with `peerToken`,
  `procStart` and `pidDomain`. `peerToken` is **not** the session's own
  `CLAUDE_CODE_MESSAGING_TOKEN`; it is the token the session publishes for other senders.

## The wire format

Found in the binary's own startup log line, which shows how to inject a message. Connect to
the socket and write newline-delimited JSON:

```
{"type":"auth","token":"<token>"}
{"type":"user","message":{"role":"user","content":"<text>"}}
```

The server sends **nothing back**: no acknowledgement for the auth line or the message.

## Results

| Case | Result |
|---|---|
| Idle recipient, own `CLAUDE_CODE_MESSAGING_TOKEN` | Delivered within seconds as a turn of its own, with no user prompt |
| Idle recipient, the published `peerToken` (how a separate `mshape` must send) | Delivered, the same way |
| Busy recipient (mid-turn) | Delivered as a reminder inside the running turn, not dropped |
| Socket path that doesn't exist | `connect ENOENT` in about 10 ms: pruning a stale registration costs nothing |

Claude Code wraps a delivered message as "Another Claude session sent a message", with
guidance to treat it as a teammate's request, not the user's. The injected turn also fires
`UserPromptSubmit`, so the inbox hook printed the unread subject alongside the notice.

The agent deferred each notice, confirmed with `mshape msg inbox` that the message was still
unread, and later read it with `mshape msg read`. The notice marked nothing read.

## Consequences for `f4y.10`

- **Liveness is "connect succeeds", not an acknowledgement.** The plan says to prune a
  registration whose socket doesn't answer; since the socket never answers, that means a
  refused connection or a missing path, plus a gone process (`procStart` against the live pid).
- **The registry may not be needed for addressing.** `~/.claude/sessions/*.json` already maps
  each live session to its `cwd` and socket; `mshape msg register` adds the track and a
  version check, and keeps `mshape` from scanning Claude Code's private directory. Decide in
  `f4y.10`; the plan's interface (register at SessionStart) still works.
- **Always send the recipient's real `peerToken`;** whether the socket checks it can vary
  by platform and version, so never rely on either.
- **Read `peerToken` from the recipient's `.key` file at send time,** never store it in the
  mailbox or the registry, and never log it.
- **Gate on `peerProtocol === 1`.** Anything else skips the notice with a note; the mail still
  waits and shows at the next prompt.
- **A notice can reach the inbox hook too:** the `UserPromptSubmit` hook prints the subject
  again on the injected turn. Harmless now; consider dropping that hook once live notices land.

## Reproduce

From a Claude Code session in a track worktree, send a message to your own track, then:

```
token=$(jq -r .peerToken ~/.claude/sessions/<pid>.*.key)
sock=$(jq -r .messagingSocketPath ~/.claude/sessions/<pid>.json)
{ printf '{"type":"auth","token":"%s"}\n' "$token"
  printf '{"type":"user","message":{"role":"user","content":"[mshape] Message from <from>: <subject> (bun run --silent mshape msg read <id>)"}}\n'
} | (sleep 40; socat - "UNIX-CONNECT:$sock") &
```

End the turn and wait: the notice arrives with no prompt. (The spike used a small Bun script
with `node:net` in place of `socat`, passing the token only through the environment.)
