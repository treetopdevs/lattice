defmodule Treehouse.Thread do
  @moduledoc """
  Text posts with causal author lineage, irreversible tombstones and archive.

  Every command is judged against only its own honored causal history. The
  moderator role guards the complete moderation/archive command. References,
  transport routes and capacity slots belong to the containing Space/catalog;
  archiving this log never removes them.
  """

  use Lattice.Replica

  alias Lattice.Op

  state do
    field(:title, merge: :lww, default: "")
    field(:posts, merge: :causal_list)
    field(:moderation, authority: :moderator, default: nil)
    field(:archived, authority: :moderator, default: false)
  end

  command(:create_thread, [:title],
    do: [{:title, {:write, text!(title)}}, {:moderation, {:write, "create_thread"}}]
  )

  command(:post, [:text], do: [{:posts, {:append, text!(text)}}])
  command(:author_edit, [:post_id, :target_id, :text], do: edit(post_id, target_id, text))
  command(:author_tombstone, [:post_id, :target_id], do: tombstone(post_id, target_id))

  command(:moderator_tombstone, [:post_id, :target_id],
    do: tombstone(post_id, target_id) ++ [{:moderation, {:write, post_id}}]
  )

  command(:archive_thread, [], do: [{:archived, {:write, true}}])

  defp edit(post, target, text) when is_binary(post) and is_binary(target),
    do: [{:posts, {:edit, post, text!(text)}}]

  defp tombstone(post, target) when is_binary(post) and is_binary(target),
    do: [{:posts, {:delete, post}}]

  defp text!(text) when is_binary(text) do
    if String.valid?(text), do: text, else: raise(ArgumentError, "Treehouse text must be UTF-8")
  end

  defp text!(_), do: raise(ArgumentError, "Treehouse text must be text")

  def command_op_status(%Op{body: {:post, [_]}}, _visible, context), do: archive_status(context)

  def command_op_status(%Op{body: {command, [post, target | _]}} = op, visible, context)
      when command in [:author_edit, :author_tombstone, :moderator_tombstone] do
    targets = lineage_targets(target, post, context.visible_ops, MapSet.new([post]))

    cond do
      Enum.any?(targets, &(not MapSet.member?(visible, &1))) ->
        {:error, :application_target_not_visible}

      Enum.any?(targets, &(context.verdicts[&1] != :honored)) ->
        {:error, :application_target_quarantined}

      not valid_lineage?(targets, post, op.replica, context.visible_ops) ->
        {:error, :application_wrong_target}

      command != :moderator_tombstone and context.visible_ops[post].author != op.author ->
        {:error, :application_wrong_author}

      tombstoned?(post, context) ->
        {:error, :application_already_tombstoned}

      command == :moderator_tombstone ->
        :ok

      true ->
        archive_status(context)
    end
  end

  def command_op_status(_op, _visible, _context), do: :ok

  defp lineage_targets(target, post, ops, seen) do
    if MapSet.member?(seen, target) do
      seen
    else
      seen = MapSet.put(seen, target)

      case ops[target] do
        %Op{kind: :command, body: {:author_edit, [^post, previous, _]}} ->
          lineage_targets(previous, post, ops, seen)

        _ ->
          seen
      end
    end
  end

  defp valid_lineage?(targets, post, replica, ops) do
    match?(%Op{replica: ^replica, kind: :command, body: {:post, [_]}}, ops[post]) and
      Enum.all?(targets, fn
        ^post ->
          true

        id ->
          match?(
            %Op{replica: ^replica, kind: :command, body: {:author_edit, [^post, _, _]}},
            ops[id]
          )
      end)
  end

  defp tombstoned?(post, context) do
    Enum.any?(context.visible_ops, fn
      {id, %Op{kind: :command, body: {command, [^post, _]}}}
      when command in [:author_tombstone, :moderator_tombstone] ->
        context.verdicts[id] == :honored

      _ ->
        false
    end)
  end

  defp archive_status(context) do
    if Enum.any?(context.visible_ops, fn
         {id, %Op{kind: :command, body: {:archive_thread, []}}} ->
           context.verdicts[id] == :honored

         _ ->
           false
       end),
       do: {:error, :application_archived_thread},
       else: :ok
  end
end
