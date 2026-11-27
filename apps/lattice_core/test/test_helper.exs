# PR #221 open-finding properties (row 389 evidence) run only with `--include pr221_open`.
# The replacement demo needs Node for its TS half; `scripts/treehouse_replacement_demo.sh` runs it
# (and CI runs that script in the flagship unit job, row 528).
# Deep property runs of the replacement resolver run only with `--include deep_property`.
# Row 321: reserved for a new-class D-279 counterexample, run only with `--include r321_open`.
ExUnit.start(exclude: [:pr221_open, :replacement_demo, :deep_property, :r321_open])

__DIR__
|> Path.join("../test_support/**/*.exs")
|> Path.wildcard()
|> Enum.each(&Code.require_file/1)
