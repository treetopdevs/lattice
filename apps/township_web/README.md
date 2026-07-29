# Township Web

Phoenix LiveView boundary for the read-only Township civic instrument. It is an umbrella app and
depends only on `lattice_core`; it is not published as a package.

The default source is the integrity-verified bundle under `artifacts/township`. Source corruption
renders an unavailable state rather than unverified civic data.

```sh
~/.asdf/shims/mix deps.get
cd apps/township_web
~/.asdf/shims/mix setup
SECRET_KEY_BASE="$(~/.asdf/shims/mix phx.gen.secret)" PHX_SERVER=true ~/.asdf/shims/mix run --no-halt
```

The instrument is available at `http://localhost:4100/township`.
