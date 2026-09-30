# QW3N

A local chat client for [Ollama](https://ollama.com), with a guided installer.

No pip. No build step. No node_modules. One Python file, one folder of static
files, and everything runs on your own machine.

```bash
git clone <this-repo> qw3n
cd qw3n
./run.sh
```

The first run opens an installer instead of the chat. It checks for Python,
Ollama and a model, and runs whatever is missing — one step at a time, with
the command output streaming into the page.

---

## What it is

Ollama serves the model on `127.0.0.1:11434`. QW3N is the front end: it serves
the page, proxies your messages to Ollama, and streams the tokens back so you
watch the answer being written.

```
┌──────────────┐   HTTP    ┌──────────────────┐   HTTP   ┌─────────────┐
│ your browser │ ────────► │  server.py :8080 │ ───────► │  ollama     │
│  (any device)│ ◄──────── │  proxy + storage │ ◄─────── │  :11434     │
└──────────────┘   SSE     └──────────────────┘  tokens  └─────────────┘
```

Because the browser only ever talks to `:8080`, there is no CORS to configure
and Ollama never needs to be exposed to the network.

## Requirements

| | |
|---|---|
| **Python** | 3.9 or newer — the standard library only, nothing to install |
| **Ollama** | the installer will get it for you |
| **Disk** | 1.4 GB for `qwen3:1.7b`, 5.2 GB for `qwen3:8b` |
| **Memory** | 8 GB works with the 1.7B model; 16 GB+ for 8B and up |

macOS is the tested platform. The installer also works on Linux; on Windows
use WSL and run it inside the distribution.

## Running it

```bash
./run.sh                     # start, install if needed, open a browser
./run.sh --port 9000         # a different port
./run.sh --host 127.0.0.1    # this machine only, nothing on the LAN
./run.sh --tunnel            # reachable from anywhere (see below)
./run.sh --no-auth           # drop the password, trusted network only
./run.sh --setup             # re-open the installer later
```

`run.sh` starts `ollama serve` if it is not already up, then execs `server.py`.
You can also run `python3 server.py --open` directly if you prefer.

The terminal prints every address that works:

```
  local     http://127.0.0.1:8080
  home wifi http://192.168.1.21:8080  phone / laptop
  token     <redacted>  needed once per browser
```

### The password

A random token is generated into `data/.token` on first run and printed in the
banner. The browser asks for it once and gets an `HttpOnly` cookie back.

Set your own with `QWEN_TOKEN=whatever ./run.sh`, or turn the gate off with
`--no-auth` on a network you trust.

### Reaching it from your phone

Use the `home wifi` address. Do not type `0.0.0.0` into a browser — that is a
bind address, not a destination; it only means "listen on every interface".

iOS Safari blocks a list of ports it considers risky. If it refuses to open the
page, pick another port: `./run.sh --port 8000`.

### Reaching it from anywhere

```bash
./run.sh --tunnel                    # whichever tool is installed
./run.sh --tunnel tailscale          # private VPN, nothing public
./run.sh --tunnel tailscale --funnel # public URL
./run.sh --tunnel cloudflare         # public URL, no open port
```

Tailscale is the better default: nothing is published to the internet, only
devices on your tailnet can reach the port. Cloudflare Tunnel hands out a
public HTTPS URL with no router changes. Both print their URL in the banner.

Do not forward the port on your router unless you have the password gate on.

## The installer

First run shows the setup steps as a chat thread. Each one is probed against
the machine, and the missing ones can be run from the page:

| step | what it does |
|---|---|
| Check Python | confirms 3.9+ is running the server |
| Homebrew | macOS only, optional, shown as a copyable command |
| Install Ollama | `brew install --cask ollama`, or a link to the `.dmg` |
| Start the Ollama server | spawns `ollama serve` and waits for its port |
| Download the model | `ollama pull <model>`, with a picker for which one |
| Verify end to end | sends a 2-token test message through the whole chain |

Re-open it any time with `./run.sh --setup`, or from **Settings → Installer**.

### Why it is safe to let a web page run commands

It is not a general command runner:

- The browser may only send a **step id**. There is no field for a command,
  and anything else in the body is ignored.
- Every command is a literal `argv` list written in `server.py`. Nothing from
  the browser is ever passed to a shell.
- The one parameter — a model name — is matched against
  `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$` before it reaches `argv`.
- The endpoint is behind the same token as everything else.
- Finishing setup **deletes the runner for the rest of the process**. To get
  it back you have to restart the server with `--setup`.
- Every step is appended to `data/setup.log`.

## What lives where

```
data/chats/*.json     one file per conversation
data/.trash/          deleted chats — move one back to restore it
data/.token           the password, mode 600
data/setup.json       chosen model + installer state
data/setup.log        what the installer ran
```

Deleting a conversation moves the file to `data/.trash/` instead of erasing
it, so a mis-click is recoverable. Back up the whole `data/` folder to keep
your history.

## Configuration

| variable | default | |
|---|---|---|
| `QWEN_TOKEN` | generated | the access password |
| `QWEN_MODEL` | `qwen3:8b` | model used when the installer has not chosen one |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | where Ollama is listening |
| `QWEN_MAX_TRIES` | `8` | wrong passwords per minute before lockout |
| `QWEN_ACCESS_LOG` | unset | set to `1` to log every HTTP request |

Sampling parameters (temperature, top-p, context window) live in the Settings
drawer and are remembered per browser in `localStorage`.

## Troubleshooting

**"ollama offline" in the corner** — Ollama is not answering on 11434.
`ollama serve` in another terminal, or re-run the installer's server step.

**The page loads but every request is 401** — the cookie was cleared or came
from a different token. Copy the token from the banner and unlock again.

**Safari says "not allowed to use restricted network port"** — iOS blocks some
ports. Use a different one, e.g. `--port 8000`.

**It is very slow** — the bottleneck is inference, not the browser. Use a
smaller model, or a tighter quant. First token is always slow while the
weights load into memory; after that expect 20–40 tok/s for an 8B on Apple
Silicon.

**Port already in use** — `lsof -i :8080` to find the owner, then use
`--port` for something else.

## License

MIT — see [LICENSE](LICENSE).
