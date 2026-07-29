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
      signing_secret: "fixture-signing-secret",
      live_view: [signing_salt: "fixture-signing-salt"]
    """)

    findings = SharedConfigSecurity.hardcoded_secrets(fixture)

    assert MapSet.new(Enum.map(findings, & &1.key)) ==
             MapSet.new([
               :secret_key_base,
               :database_password,
               :signing_secret,
               :signing_salt
             ])
  end
end

defmodule TownshipWeb.SharedConfigSecurity do
  @moduledoc false

  alias Sobelow.Config.Secrets
  alias Sobelow.Parse

  @skipped_config_files ~w(dev.exs test.exs dev.secret.exs test.secret.exs)
  @secret_key_fragments ~w(password secret salt token key_base)

  def config_files(config_dir) do
    config_dir
    |> Path.join("*.exs")
    |> Path.wildcard()
    |> Enum.reject(&(Path.basename(&1) in @skipped_config_files))
    |> Enum.sort()
  end

  def hardcoded_secrets(config_file) do
    config_file
    |> Parse.ast()
    |> Macro.prewalk([], &extract_config_findings(&1, &2, config_file))
    |> elem(1)
    |> Enum.uniq_by(&{&1.key, &1.line})
    |> Enum.sort_by(&{&1.file, &1.line, &1.key})
  end

  defp extract_config_findings({:config, _, args} = ast, findings, file)
       when is_list(args) do
    direct_findings =
      case args do
        [_, key, value] when is_atom(key) ->
          literal_finding(file, ast, key, value)

        _other ->
          []
      end

    nested_findings =
      case List.last(args) do
        keyword when is_list(keyword) ->
          keyword_findings(file, ast, keyword)

        _other ->
          []
      end

    {ast, direct_findings ++ nested_findings ++ findings}
  end

  defp extract_config_findings(ast, findings, _file), do: {ast, findings}

  defp keyword_findings(file, ast, keyword) do
    if Keyword.keyword?(keyword) do
      Enum.flat_map(keyword, fn {key, value} ->
        own_findings =
          if sensitive_key?(key), do: literal_finding(file, ast, key, value), else: []

        nested_findings =
          if is_list(value), do: keyword_findings(file, ast, value), else: []

        own_findings ++ nested_findings
      end)
    else
      []
    end
  end

  defp sensitive_key?(key) when is_atom(key) do
    key = key |> Atom.to_string() |> String.downcase()
    Enum.any?(@secret_key_fragments, &String.contains?(key, &1))
  end

  defp sensitive_key?(_key), do: false

  defp literal_finding(file, ast, key, value)
       when is_binary(value) and byte_size(value) > 0 do
    if Secrets.env_var?(value) do
      []
    else
      [%{file: file, key: key, line: Parse.get_fun_line(ast)}]
    end
  end

  defp literal_finding(_file, _ast, _key, _value), do: []
end
