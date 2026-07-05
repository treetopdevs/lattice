defmodule Lattice.Replica do
  @moduledoc """
  The Replica DSL.

  A Replica module declares its convergent/authoritative state and the pure
  commands that mutate it. A Replica's *identity* is its op-log; this module
  describes how to interpret that log.

      defmodule Lattice.Demo.Thread do
        use Lattice.Replica

        state do
          field :title, merge: :lww, default: ""
          field :messages, merge: :causal_list
          field :participants, merge: :or_set
          field :locked?, authority: :moderator, default: false
        end

        command :set_title, [:text], do: [{:title, {:write, text}}]
        command :post, [:text],      do: [{:messages, {:append, text}}]
        command :join, [:realm],     do: [{:participants, {:add, realm}}]
        command :leave, [:realm],    do: [{:participants, {:remove, realm}}]
        command :lock, [],           do: [{:locked?, {:write, true}}]
        command :unlock, [],         do: [{:locked?, {:write, false}}]

        ephemeral :typing, [:who],   do: {:typing, who}

        succession :moderator, to: "realm:tab", after: {:dormant_ticks, 3}
      end

  ## Rules

    * **Commands are pure reducers** producing a list of `{field, mutation}` from
      their arguments alone — no state reads, no side effects, no wall clock. This
      is what keeps reduction convergent: a mutation like `{:write, v}` /
      `{:add, e}` / `{:append, v}` is absolute, never relative (no `toggle`).
    * `merge:` selects a CRDT (`:lww | :or_set | :causal_list`).
    * `authority:` marks a serialized field: only the current authority holder's
      command ops may mutate it; everyone else's are queued through the holder or
      quarantined (see `Lattice.Authority`).
    * `ephemeral` declarations are live-only and never produce log ops.
  """

  @type field_name :: atom()
  @type mutation :: {field_name(), term()}

  defmacro __using__(_opts) do
    quote do
      import Lattice.Replica,
        only: [
          state: 1,
          field: 1,
          field: 2,
          command: 3,
          ephemeral: 3,
          succession: 2
        ]

      Module.register_attribute(__MODULE__, :lattice_fields, accumulate: true)
      Module.register_attribute(__MODULE__, :lattice_commands, accumulate: true)
      Module.register_attribute(__MODULE__, :lattice_ephemeral, accumulate: true)
      Module.register_attribute(__MODULE__, :lattice_succession, accumulate: true)
      @before_compile Lattice.Replica
    end
  end

  @doc "Wraps a block of `field/1,2` declarations."
  defmacro state(do: block), do: block

  @doc "Declare a state field with a `merge:` CRDT or `authority:` role."
  defmacro field(name, opts \\ []) do
    quote bind_quoted: [name: name, opts: opts] do
      @lattice_fields {name, Lattice.Replica.__normalize_field__(name, opts)}
    end
  end

  @doc "Declare a pure command: `command :name, [:arg, ...], do: mutations`."
  defmacro command(name, args, do: block) do
    arg_vars = Enum.map(args, fn a -> Macro.var(a, nil) end)

    quote do
      @lattice_commands {unquote(name), unquote(length(args)), unquote(args)}
      def __apply_command__(unquote(name), [unquote_splicing(arg_vars)]) do
        unquote(block)
      end
    end
  end

  @doc "Declare a live-only message constructor (never logged)."
  defmacro ephemeral(name, args, do: block) do
    arg_vars = Enum.map(args, fn a -> Macro.var(a, nil) end)

    quote do
      @lattice_ephemeral {unquote(name), unquote(length(args))}
      def __ephemeral__(unquote(name), [unquote_splicing(arg_vars)]) do
        unquote(block)
      end
    end
  end

  @doc "Declare a succession policy for an authority role."
  defmacro succession(role, opts) do
    quote bind_quoted: [role: role, opts: opts] do
      @lattice_succession {role, Map.new(opts)}
    end
  end

  defmacro __before_compile__(_env) do
    quote do
      @doc false
      def __lattice_fields__, do: Enum.reverse(@lattice_fields)
      @doc false
      def __lattice_commands__, do: Enum.reverse(@lattice_commands)
      @doc false
      def __lattice_ephemeral__, do: Enum.reverse(@lattice_ephemeral)
      @doc false
      def __lattice_succession__, do: Map.new(@lattice_succession)

      @doc false
      def __apply_command__(name, args) do
        raise ArgumentError,
              "#{inspect(__MODULE__)} has no command #{inspect(name)}/#{length(args)}"
      end

      @doc "Build a validated command body `{name, args}` for an op."
      def command_body(name, args) when is_list(args) do
        commands = __lattice_commands__()
        arity = length(args)

        cond do
          # Match on name AND arity, so overloaded command names resolve correctly.
          Enum.any?(commands, fn {n, a, _} -> n == name and a == arity end) ->
            {:ok, {name, args}}

          Enum.any?(commands, fn {n, _a, _} -> n == name end) ->
            arities = for {^name, a, _} <- commands, do: a
            {:error, {:bad_arity, name, expected: arities, got: arity}}

          true ->
            {:error, {:unknown_command, name}}
        end
      end

      @doc "Field spec for `name`, or nil."
      def field_spec(name), do: List.keyfind(__lattice_fields__(), name, 0)

      @doc "The authority role guarding `field`, or nil if convergent."
      def authority_role(field) do
        case field_spec(field) do
          {^field, %{kind: :authority, role: role}} -> role
          _ -> nil
        end
      end
    end
  end

  @doc false
  def __normalize_field__(name, opts) do
    if Keyword.has_key?(opts, :authority) and Keyword.has_key?(opts, :merge) do
      raise ArgumentError,
            "field #{inspect(name)}: `authority:` and `merge:` are mutually exclusive"
    end

    cond do
      role = Keyword.get(opts, :authority) ->
        %{kind: :authority, role: role, default: Keyword.get(opts, :default)}

      merge = Keyword.get(opts, :merge) ->
        unless merge in [:lww, :or_set, :causal_list] do
          raise ArgumentError, "unknown merge strategy #{inspect(merge)}"
        end

        %{kind: :crdt, crdt: merge, default: Keyword.get(opts, :default)}

      true ->
        raise ArgumentError, "field needs either merge: or authority:"
    end
  end
end
