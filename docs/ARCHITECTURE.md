# How QW3N is put together

Five files carry the whole app. Nothing here needs a package manager.

| file | lines | what it owns |
|---|---|---|
| `server.py` | ~1100 | routing, auth, streaming proxy, chat storage, the installer |
| `static/index.html` | 280 | the DOM, plus the in-app "How this works" explainer |
| `static/style.css` | 1300 | the Liquid Glass design system |
| `static/app.js` | 920 | chat state, SSE reader, settings drawer |
| `static/setup.js` | 400 | the first-run installer, drawn as a chat thread |
| `static/markdown.js` | 352 | markdown + syntax highlighting, hand-rolled |

## The request path

1. The browser POSTs to `/api/chat` on `:8080`.
2. `server.py` re-frames the request for Ollama's `/api/chat`.
3. Ollama starts emitting newline-delimited JSON.
4. `server.py` re-wraps each line as `data: {...}` and flushes.
5. `app.js` reads the stream and re-renders one message bubble per token.

The re-framing in step 4 is the only reason this app exists as a server rather
than a static page: it keeps Ollama on `127.0.0.1`, which removes the CORS
problem entirely.

## Streaming

`protocol_version = "HTTP/1.1"` with an explicit `Connection: close` on the
SSE response, and `X-Accel-Buffering: no` so reverse proxies do not hold the
chunks. Reads are 1 KB at a time; a partial line is held in `pending` until
its newline arrives.

## Storage

One JSON file per conversation in `data/chats/`. No database, no migrations.
`save_chat` is a read-merge-write, which is why a chat is the only thing that
can lose data if two tabs write at once.

Deleting moves the file to `data/.trash/` and prunes anything older than 30
days. See the incident note in the git log.

## The installer

`STEPS` in `server.py` is a list of dicts, each with a `probe` that reports
state and, where useful, an `argv` to run. `StepRun.events()` turns one step
into a stream of JSON events the page renders as terminal output.

The security model is the important part:

- The request body carries `id` and nothing else that is honoured.
- Commands are `argv` lists — no `shell=True` anywhere in the setup path.
- The model name is regex-validated in `pick_model`.
- `SETUP_ENABLED` goes `False` in `setup_finish()`, and the run endpoint
  returns 403 from then on.

To add a step, append to `STEPS`. If it needs a command, write the `argv` by
hand in the probe. Do not build one from request data.

## Design

The interface is built from translucent layers, macOS Tahoe style:

```css
background   rgba(255,255,255,.055)   /* thin white film   */
backdrop     saturate(190%) blur(42px) /* the refraction    */
box-shadow   inset 0 1px 0 <sheen>     /* light on the edge */
            0 24px 60px -28px #000     /* the shadow cast   */
```

Four `.aurora` blobs drift behind everything. They are not decoration — glass
is invisible without something to refract, and a flat background makes the
whole thing read as plain dark grey.

Tokens live at the top of `style.css`. Changing `--blue` and `--blur` moves
the whole interface.

## Scripts

`markdown.js` and `app.js` are classic scripts sharing one global scope, so
they cannot declare the same top-level name. `setup.js` is wrapped in an IIFE
for exactly this reason — it has a `render()` and so does `app.js`.
