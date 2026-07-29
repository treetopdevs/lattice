defmodule TownshipWeb.SharedConfigSecurityTest do
  use ExUnit.Case, async: false

  alias TownshipWeb.SharedConfigSecurity

  @shared_config_dir Path.expand("../../../../config", __DIR__)

  test "shared non-test configuration contains no hard-coded secrets" do
    findings =
      @shared_config_dir
      |> SharedConfigSecurity.config_files()
      |> Enum.flat_map(&SharedConfigSecurity.hardcoded_secrets/1)

    assert findings == []
  end

  @tag :tmp_dir
  test "detects exact and fuzzy hard-coded secrets", %{tmp_dir: tmp_dir} do
    fixture = Path.join(tmp_dir, "runtime.exs")

    File.write!(fixture, """
    import Config

    config :township_web, TownshipWeb.Endpoint,
      secret_key_base: "fixture-secret-key-base"

    config :fixture,
      database_password: "fixture-password",
      signing_secret: "fixture-signing-secret"
    """)

    findings = SharedConfigSecurity.hardcoded_secrets(fixture)

    assert MapSet.new(Enum.map(findings, & &1.key)) ==
             MapSet.new([:secret_key_base, :database_password, :signing_secret])
  end
end

defmodule TownshipWeb.SharedConfigSecurity do
  @moduledoc false

  @skipped_config_files ~w(dev.exs test.exs dev.secret.exs test.secret.exs)

  def config_files(config_dir) do
    config_dir
    |> Path.join("*.exs")
    |> Path.wildcard()
    |> Enum.reject(&(Path.basename(&1) in @skipped_config_files))
    |> Enum.sort()
  end

  def hardcoded_secrets(config_file) do
    exact_findings =
      :secret_key_base
      |> Sobelow.Config.get_configs(config_file)
      |> Enum.flat_map(fn {ast, key, value} ->
        literal_finding(config_file, ast, key, value)
      end)

    fuzzy_findings =
      ["password", "secret"]
      |> Enum.flat_map(fn key_fragment ->
        key_fragment
        |> Sobelow.Config.get_fuzzy_configs(config_file)
        |> Enum.flat_map(fn {ast, values} ->
          Enum.flat_map(values, fn {key, value} ->
            literal_finding(config_file, ast, key, value)
          end)
        end)
      end)

    (exact_findings ++ fuzzy_findings)
    |> Enum.uniq_by(&{&1.key, &1.line})
    |> Enum.sort_by(&{&1.file, &1.line, &1.key})
  end

  defp literal_finding(file, ast, key, value)
       when is_binary(value) and byte_size(value) > 0 do
    if Sobelow.Config.Secrets.env_var?(value) do
      []
    else
      [%{file: file, key: key, line: Sobelow.Parse.get_fun_line(ast)}]
    end
  end

  defp literal_finding(_file, _ast, _key, _value), do: []
end
