# qp: quick prompts for Claude Code

A Claude Code mod that suggests four follow-up prompts after each turn, in the band above the prompt box. Type `1`–`4` into an empty prompt and pause to put one in the prompt box, then press Enter to send it or edit it first.

```text
quick prompts · smart · haiku   (type 1-4 to pick · Enter to send · /qp off)
1: Run the tests and smoke-check the band hotkeys
2: Add a unit test for parseSuggestions
3: Why does $.model.fork need the final answer passed in?
4: Explain how the generation ticket drops stale suggestions
```

## Install

Mods need Claude Code 2.1.287 or later. qp was tested on 2.1.305.

In a Claude Code session:

```
/plugin marketplace add Jaleel-VS/qp-mod
/plugin install qp@qp
```

Third-party marketplaces don't update by themselves. Turn on auto-update in `/plugin` > Marketplaces to get new versions.

To run from a clone instead, load the folder for one session:

```sh
claude --plugin-dir /path/to/qp-mod
```

To load the clone in every session, add it to your shell profile:

```sh
export CLAUDE_CODE_PLUGIN_DIRS=/path/to/qp-mod
```

## Use

| Action | How |
|---|---|
| Put suggestion N in the prompt box | Type `N` into an empty prompt and pause, or run `/qp edit N`. Press Enter to send it, or edit it first. |
| Send suggestion N at once | `/qp N` |
| Show the current mode and model | `/qp` |
| Change mode | `/qp smart`, `/qp learn`, `/qp fixed`, or `/qp off` |
| Change the model behind smart and learn | `/qp model haiku` or `/qp model session` |

The mode and model are saved and carry over to new sessions.

### Modes

- **smart** (the default): after each turn, one side request suggests four likely next messages. If Claude ended its turn with a question, the first suggestion answers it.
- **learn**: the same side request, but the four suggestions help you understand the work: a "why does this work" question, a "what if" question, the underlying concept, and a "quiz me".
- **fixed**: no model call. Four stock prompts chosen from what the turn did (asked a question, edited files, hit an error).
- **off**: nothing.

### Models

| | `haiku` (the default) | `session` |
|---|---|---|
| Request | `$.model.complete` on Haiku | `$.model.fork` on the session's model |
| What it reads | Your last message, Claude's reply, and which tools the turn used | The whole conversation, then Claude's reply |
| Latency | About 1.6 s | About 2.4 s with the prompt cache warm, 7 s or more when it isn't |
| Suggestions | About the last exchange only | Can refer back to earlier turns |

The latencies are medians from 9 turns over 3 new sessions, on Sonnet on Amazon Bedrock. A `session` request resends the session's full context, about 100K tokens even early in a session, because that includes the system prompt and tool list.

If a smart or learn request fails, takes more than 30 seconds, or its reply can't be parsed, the band falls back to the fixed prompts and the header says why.

## How it behaves

- Suggestions appear only for the main conversation's turns that end with an answer. Subagent turns, interrupted turns, and errors are skipped.
- Suggestions clear when the next turn starts, so a stale set is never sent.
- The band is shared with other mods. qp draws other mods' band content above its own.
- In a short terminal, qp drops its header and packs the suggestions into columns, so all four stay visible. A digit only picks a suggestion that's visible.
- While suggestions are showing, a message that is just `1`–`4` becomes that suggestion, whether you pause or press Enter straight away. Type anything more to send your own text.

## What it runs and costs

- **Model calls**: in smart and learn mode, one request per turn, billed to your plan or API key. With `haiku`, a few hundred tokens to Haiku. With `session`, a fork of the conversation on the session's model, mostly served from the prompt cache. Fixed and off mode make no model calls.
- **Files, processes, network**: none. qp reads no environment variables.
- **Storage**: the mode and model, in Claude Code's plugin store.
- **Commands**: adds `/qp`.
- **Tool calls**: qp watches them to choose the fixed prompts. It passes every call through unchanged and never answers a permission prompt.

Run `claude plugin validate .` in this folder to list the hooks and calls yourself.

## Where it works

| Where | Works |
|---|---|
| `claude` in any terminal | Yes |
| Claude Desktop, Code tab | Expected to, since the band is drawn there; not tested |
| VS Code extension | No: the band above the prompt isn't drawn there |
| `claude -p` and the Agent SDK | No: nothing is drawn |

## License

[MIT](LICENSE)
