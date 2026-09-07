# Offline root-only Treehouse proof; no live enrollment, catalog or recovery claim.
alias Lattice.{Authority, Identity, Log, Op, Sim}
alias Treehouse.{Invitation, ReadModel, Space, Thread}

root = Identity.from_seed("root", "treehouse-demo:root")
{:ok, creation} = Space.prepare_creation(root, "treehouse:demo:space", "Canopy")
[genesis, name] = creation.pending
space = Log.append!(Log.new(creation.replica), genesis)
:incomplete = Space.initialization(space)
{:ok, %{pending: [^name]}} = Space.prepare_creation(root, creation.replica, "Canopy", space)
space = Log.append!(space, name)
:ready = Space.initialization(space)
IO.puts("Root-only Space creation retains one root and resumes the exact signed name command.")

{thread, thread_genesis} =
  Thread
  |> Sim.new("treehouse:demo:thread", ["root", "member"], seed: "treehouse-demo")
  |> Sim.create_replica("root")

{thread, _} = Sim.command(thread, "root", :create_thread, ["Welcome"])

{thread, member_cap} =
  Sim.grant(thread, "root", "member", ops: [:post, :author_edit, :author_tombstone])

thread = Sim.sync_all(thread)
member = Sim.identity(thread, "member")
{:genesis, space_cap, %{}} = genesis.body

reference =
  Op.new(
    root,
    space.replica,
    Log.frontier(space),
    :command,
    {:create_thread, [Sim.replica(thread), "Welcome"]}, cap: space_cap.id)

space = Log.append!(space, reference)

invite =
  Op.new(
    root,
    space.replica,
    Log.frontier(space),
    :command,
    {:issue_invitation, [Base.encode64(member.pub), [Sim.replica(thread)]]}, cap: space_cap.id)

space = Log.append!(space, invite)
acceptance = Invitation.accept(member, space.replica, invite)

admit =
  Op.new(
    root,
    space.replica,
    Log.frontier(space),
    :command,
    {:admit_member, [invite.id, Base.encode64(member.pub), "member", acceptance]},
    cap: space_cap.id
  )

space = Log.append!(space, admit)
{thread, post} = Sim.command(thread, "member", :post, ["Offline history"], cap: member_cap.id)

{thread, _} =
  Sim.command(thread, "member", :author_edit, [post.id, post.id, "Edited offline history"],
    cap: member_cap.id
  )

thread = Sim.sync_all(thread)
{:genesis, thread_cap, _} = thread_genesis.body

{transfer, moderator_cap} =
  Space.change_moderator(root, Sim.log(thread, "root"), member.pub, thread_cap)

thread_log = Log.append!(Sim.log(thread, "root"), transfer)

archive =
  Op.new(member, thread_log.replica, Log.frontier(thread_log), :command, {:archive_thread, []},
    cap: moderator_cap.id
  )

thread_log = Log.append!(thread_log, archive)
true = Authority.holder(Thread, thread_log, :moderator) == member.pub
{:ok, view} = ReadModel.thread(space, thread_log.replica, thread_log)
true = view.state.archived
[%{id: original_id, text: "Edited offline history"}] = view.posts
true = original_id == post.id

IO.puts(
  "Recipient acceptance, exact-replica fixture grants, edited post identity and real moderator transfer replay locally."
)

path = Path.join(System.tmp_dir!(), "treehouse-demo-#{System.unique_integer([:positive])}.log")

try do
  :ok = Log.dump(thread_log, path)
  {:ok, restored} = Log.restore(path)
  true = ReadModel.observe(Thread, restored) == view

  IO.puts(
    "Archive retains the Space reference and all #{view.operation_count} signed Thread operations; dump/restore preserves the projection."
  )
after
  File.rm(path)
end

IO.puts(
  "Local fixture proof only: no hosted catalog, native custody, bounded founder-loss policy or pilot readiness is implied."
)
