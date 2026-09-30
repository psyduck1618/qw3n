# Contributing

Thanks for looking at it. It is a small project with a hard rule: **no
dependencies, no build step**. A pull request that adds a `package.json` or a
`requirements.txt` will not be merged.

## Branches

| branch | what lives there |
|---|---|
| `main` | released, stable. People who `git clone` get this. |
| `develop` | the integration branch. Everything merges here first. |

```
main      ●───────●─────────●          releases only
         ╱
develop   ●───●───●───●───●──●         day to day
         ╱   ╱
feature   ●───●  ●───●
```

Open your branch from `develop`, not `main`.

```bash
git clone https://github.com/psyduck1618/qw3n.git
cd qw3n
git remote add upstream https://github.com/psyduck1618/qw3n.git
git fetch upstream

git switch develop
git switch -c feature/my-thing
```

Name it `feature/…`, `fix/…` or `docs/…`. One topic per branch — a pull
request that does two unrelated things takes twice as long to review.

## Running it while you work

```bash
./run.sh
```

If you are changing the server, restart it; Python will not hot-reload. There is
no watcher in this project on purpose.

Useful flags while developing:

| | |
|---|---|
| `./run.sh --port 8140` | don't fight the other copy you have running |
| `./run.sh --no-auth` | skip the token gate locally |
| `./run.sh --setup` | re-open the installer after it is finished |
| `QWEN_ACCESS_LOG=1 ./run.sh` | log every HTTP request |
| `QWEN_TOKEN=devtoken ./run.sh` | use a token you can type from memory |

## Before you open a pull request

```bash
python3 -m py_compile server.py   # must be clean
bash -n run.sh                    # must be clean
```

Then start the server and click through whatever you changed. There is no
automated test suite — that is a real gap, and a PR that adds one would be very
welcome.

Please keep a pull request to one thing. If you find yourself writing
"…and I also refactored…", split it.

## Adding a setup step

The installer is a list in `STEPS` in `server.py`. Append a dict with a `probe`
that reports state, and if it needs to run something, a literal `argv`:

```python
{
    "id": "mystep",
    "title": "Do the thing",
    "body": "Shown in the page, explain why this matters.",
    "probe": probe_mystep,
    # argv only. Never build one from anything a browser sent.
    "argv": ["some-tool", "--flag"],
    "display": "some-tool --flag",
}
```

The security rules for that file are not optional. The browser may only send a
step **id**; there is no field for a command; `shell=True` does not appear
anywhere in the setup path; the one parameter (a model name) is regex-validated
in `pick_model`. A step that needs something more exotic than a literal argv is
a sign it probably should not be a setup step.

## House style

- The server is one file on purpose. Do not split it into a package.
- Comment the *why*, not the *what*.
- CSS custom properties live at the top of `style.css`. Move `--blue` or
  `--blur` and the whole interface follows — use them instead of new hex codes.
- `static/setup.js` and `static/app.js` are classic scripts sharing a global
  scope. They both have a `render()`, which is why `setup.js` is wrapped in an
  IIFE. If you add a top-level function, check it does not collide.
- Markdown is rendered by `static/markdown.js`, which is hand-rolled. No
  libraries.

## Reporting a bug

Open an issue with what you did, what happened, and what you expected. Say which
OS, Python version (`python3 -V`) and model you are on — most problems are one
of those. If the server printed a traceback, paste it.

Security problems: please do not open a public issue. Message the maintainer
instead.

## Licence

Contributions are accepted under the same MIT licence as the rest — see
[LICENSE](LICENSE).
