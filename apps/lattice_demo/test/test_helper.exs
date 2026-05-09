ExUnit.start()

__DIR__
|> Path.join("../test_support/**/*.exs")
|> Path.wildcard()
|> Enum.each(&Code.require_file/1)
