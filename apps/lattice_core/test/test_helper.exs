# PR #221 open-finding properties (row 389 evidence) run only with `--include pr221_open`.
# Deep property runs of the replacement resolver run only with `--include deep_property`.
ExUnit.start(exclude: [:pr221_open, :deep_property])

__DIR__
|> Path.join("../test_support/**/*.exs")
|> Path.wildcard()
|> Enum.each(&Code.require_file/1)
