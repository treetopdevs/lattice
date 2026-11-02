defmodule Lattice.Graph.AuthorityBody do
  @moduledoc """
  One total read-side parser for admitted op bodies (row 309).

  An admitted op body is attacker-shaped: structural admission checks the hash
  and signature, not the shape of every nested field. Read-side consumers
  (`Lattice.Graph.ReplicaSnapshot`, `Township.ReadModel`) therefore render from
  `parse/1`, which never raises on any term, instead of pattern matching raw
  fields that may not be what their names promise.

  This module only parses for display. It decides nothing about authority, and
  a parsed field is not evidence that the judge honored the op. `:malformed`
  markers stay in the output so a later reader can count omissions.
  """

  alias Lattice.Authority.Delegation
  alias Lattice.Canonical

  @type field(value) :: {:ok, value} | :malformed
  @type dview :: %{
          issuer: field(binary()),
          audience: field(binary()),
          roles: field([String.t()]),
          ops: field([String.t()]),
          well_formed?: boolean()
        }
  @type role :: {:name, term(), String.t()} | {:malformed, term()}
  @type tick :: {:tick, integer()} | {:witnessed, term()} | {:malformed, term()}
  @type parsed ::
          {:genesis, dview()}
          | {:grant, dview()}
          | {:transfer, role(), dview(), tick()}
          | {:succeed, role(), dview(), tick()}
          | {:heartbeat, role(), tick()}
          | {:revoke, {:ok, binary()} | {:malformed, term()}}
          | {:request, term()}
          | {:command, atom(), list()}
          | {:other, term()}

  @doc "Parse any op body into a display-safe shape. Total: never raises."
  @spec parse(term()) :: parsed()
  def parse({:genesis, deleg, _policies}), do: {:genesis, dview(deleg)}
  def parse({:grant, deleg}), do: {:grant, dview(deleg)}

  def parse({:transfer, role, deleg, tick}),
    do: {:transfer, role(role), dview(deleg), tick(tick)}

  def parse({:succeed, role, deleg, {:witnessed, certificate}}),
    do: {:succeed, role(role), dview(deleg), {:witnessed, certificate}}

  def parse({:succeed, role, deleg, tick}),
    do: {:succeed, role(role), dview(deleg), tick(tick)}

  def parse({:heartbeat, role, tick}), do: {:heartbeat, role(role), tick(tick)}
  def parse({:revoke, target}) when is_binary(target), do: {:revoke, {:ok, target}}
  def parse({:revoke, target}), do: {:revoke, {:malformed, target}}
  def parse({:request, ref, _payload}), do: {:request, ref}
  def parse({cmd, args}) when is_atom(cmd) and is_list(args), do: {:command, cmd, args}
  def parse(body), do: {:other, body}

  # --- Delegation view -------------------------------------------------------

  # Each field parses on its own so a reader can still show a good audience on
  # a delegation with ill-formed roles. `well_formed?` is the stricter filter:
  # the judge-side shape check plus 32-byte Ed25519 keys.
  defp dview(deleg) when is_map(deleg) do
    issuer = key(deleg, :issuer)
    audience = key(deleg, :audience)

    %{
      issuer: issuer,
      audience: audience,
      roles: names(deleg, :roles),
      ops: names(deleg, :ops),
      well_formed?:
        Delegation.well_formed?(deleg) and match?({:ok, _}, issuer) and
          match?({:ok, _}, audience)
    }
  end

  defp dview(_other),
    do: %{
      issuer: :malformed,
      audience: :malformed,
      roles: :malformed,
      ops: :malformed,
      well_formed?: false
    }

  defp key(map, field) do
    case Map.get(map, field) do
      pub when is_binary(pub) and byte_size(pub) == 32 -> {:ok, pub}
      _other -> :malformed
    end
  end

  # Same member rule as Delegation.well_formed?/1: a map-backed MapSet of
  # atoms, binaries, integers or binary-name Canonical.Atom wrappers. Members
  # sort in Erlang term order, then convert through String.Chars (`nil` becomes
  # ""), so the joined text matches what the readers printed before. A binary
  # name that is not valid UTF-8 is admissible but not display text (it would
  # break JSON and LiveView serialization), so it makes the field `:malformed`.
  defp names(map, field) do
    case Map.get(map, field) do
      %MapSet{map: backing} = set when is_map(backing) ->
        members = Enum.to_list(set)

        if Enum.all?(members, &name?/1),
          do: {:ok, members |> Enum.sort() |> Enum.map(&text/1)},
          else: :malformed

      _other ->
        :malformed
    end
  end

  defp name?(name) when is_atom(name) or is_integer(name), do: true
  defp name?(name) when is_binary(name), do: String.valid?(name)
  defp name?(%Canonical.Atom{name: name}) when is_binary(name), do: String.valid?(name)
  defp name?(_other), do: false

  defp text(name) when is_binary(name), do: name
  defp text(name) when is_atom(name) or is_integer(name), do: to_string(name)
  defp text(%Canonical.Atom{name: name}), do: name

  # --- Role and tick ----------------------------------------------------------

  # The parsed text is display-safe: a binary role name that is not valid UTF-8
  # stays `{:malformed, raw}` rather than becoming text.
  defp role(role) when is_atom(role), do: {:name, role, to_string(role)}
  defp role(role) when is_binary(role), do: text_role(role, role)
  defp role(%Canonical.Atom{name: name} = role) when is_binary(name), do: text_role(role, name)
  defp role(role), do: {:malformed, role}

  defp text_role(raw, name),
    do: if(String.valid?(name), do: {:name, raw, name}, else: {:malformed, raw})

  defp tick(tick) when is_integer(tick), do: {:tick, tick}
  defp tick(tick), do: {:malformed, tick}
end
