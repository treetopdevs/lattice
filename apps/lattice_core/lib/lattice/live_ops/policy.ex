defmodule Lattice.LiveOps.Policy do
  @moduledoc """
  Grant-time policy for the LiveOps demo: which roles exist, which actions and
  devices each role is minted caps for, and the attenuation opts for each cap.

  This module only decides *which* capabilities to issue. It never authorizes a
  call. Every minted cap carries its constraints (action caveat, schema, ttl,
  use limit) into `Lattice.CapStore`, which is the single authority that
  enforces them. There is no parallel enforcement here.
  """

  alias Lattice.Cap.Caveat

  @roles [:producer, :graphics_operator, :remote_camera, :observer]

  @role_colors %{
    producer: "#2f6fed",
    graphics_operator: "#8a4fff",
    remote_camera: "#008f6b",
    observer: "#6b7280"
  }

  @role_actions %{
    producer: [:approve_publish, :revoke_publish, :observe],
    graphics_operator: [:preview_overlay, :request_publish, :observe],
    remote_camera: [:observe],
    observer: [:observe]
  }

  @role_devices %{
    producer: [:preview_monitor],
    graphics_operator: [:graphics_renderer],
    remote_camera: [:camera_feed, :tally_light],
    observer: []
  }

  @device_actions %{
    camera_feed: :camera_frame,
    graphics_renderer: :render_graphics,
    tally_light: :set_tally,
    preview_monitor: :monitor_preview
  }

  def roles, do: @roles
  def role_actions(role), do: Map.fetch!(@role_actions, role)
  def role_devices(role), do: Map.fetch!(@role_devices, role)
  def device_action(kind), do: Map.fetch!(@device_actions, kind)
  def color_for(role), do: Map.fetch!(@role_colors, role)

  def normalize_role(role) when is_atom(role) and role in @roles, do: role

  def normalize_role(role) when is_binary(role) do
    role
    |> String.trim()
    |> String.downcase()
    |> String.replace("-", "_")
    |> then(fn role -> Enum.find(@roles, :observer, &(Atom.to_string(&1) == role)) end)
  end

  def normalize_role(_role), do: :observer

  @doc """
  Attenuation opts for a server-plane role-action cap.

  The action is bound as a `Caveat.action/1`, so `CapStore` denies any call
  whose payload action does not match — that is the only place wrong-action use
  is rejected.
  """
  def role_cap_opts(action, role) do
    [
      caveats: [Caveat.action(action)],
      schema: %{action: :string},
      audit: %{
        liveops_action: Atom.to_string(action),
        liveops_role: Atom.to_string(role),
        liveops_kind: "role",
        liveops_target: "server_plane"
      }
    ]
  end

  @doc """
  Attenuation opts for a per-device cap.

  Device caps deliberately carry no action caveat: the device target enforces
  its own immutable `kind`/`tab_id` checks (`Lattice.LiveOps.Device`). Adding a
  caveat here would duplicate that single, static check.
  """
  def device_cap_opts(action, role, device_id, kind) do
    [
      schema: %{action: :string},
      audit: %{
        liveops_action: Atom.to_string(action),
        liveops_role: Atom.to_string(role),
        liveops_kind: "device",
        liveops_target: device_id,
        liveops_device_id: device_id,
        liveops_device_kind: Atom.to_string(kind)
      }
    ]
  end

  @doc """
  Attenuation opts for a single-use, time-boxed publish cap minted on approval.
  """
  def publish_cap_opts(approval, producer_tab_id, ttl_ms) do
    [
      ttl: ttl_ms,
      use_limit: 1,
      caveats: [Caveat.action(:publish)],
      schema: %{action: :string, request_id: :string},
      audit: %{
        liveops_action: "publish",
        liveops_role: "graphics_operator",
        liveops_kind: "approval",
        liveops_target: "server_plane",
        approval_id: approval.id,
        approved_by_tab_id: producer_tab_id
      }
    ]
  end
end
