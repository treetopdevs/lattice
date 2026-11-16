# PR #221 open-finding properties (row 389 evidence) run only with `--include pr221_open`.
ExUnit.start(exclude: [:pr221_open])

__DIR__
|> Path.join("../test_support/**/*.exs")
|> Path.wildcard()
|> Enum.each(&Code.require_file/1)
