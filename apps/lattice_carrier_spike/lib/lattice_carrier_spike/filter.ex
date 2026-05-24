defmodule LatticeCarrierSpike.Filter do
  @moduledoc """
  Fail-closed `tcp_filter_dist` policy for browser-carrier traffic.

  Erlang distribution cookies authenticate a node, not an operation. This
  filter therefore allows only a JSON logical call frame sent to the carrier
  gateway registered name; every other registered-name, pid, spawn, monitor,
  exit, and RPC-shaped distribution behavior is rejected before delivery.
  """

  @behaviour TCPFilter.Filter

  alias LatticeCarrierSpike.Message

  @gateway_name LatticeCarrierSpike.gateway_name()

  @impl TCPFilter.Filter
  def filter({:reg_send, _sender, _unused, @gateway_name}, message),
    do: filter_gateway_message(message)

  def filter({:reg_send_tt, _sender, _unused, @gateway_name, _trace_token}, message),
    do: filter_gateway_message(message)

  def filter({:reg_send, _sender, _unused, _registered_name}, _message),
    do: {:error, :registered_name_denied}

  def filter({:reg_send_tt, _sender, _unused, _registered_name, _trace_token}, _message),
    do: {:error, :registered_name_denied}

  def filter({:send, _cookie, _pid}, _message), do: {:error, :pid_send_denied}
  def filter({:send_tt, _cookie, _pid, _trace_token}, _message), do: {:error, :pid_send_denied}
  def filter({:send_sender, _from, _to}, _message), do: {:error, :pid_send_denied}

  def filter({:send_sender_tt, _from, _to, _trace_token}, _message),
    do: {:error, :pid_send_denied}

  def filter({:alias_send, _sender, _alias}, _message), do: {:error, :alias_send_denied}

  def filter({:alias_send_tt, _sender, _alias, _trace_token}, _message),
    do: {:error, :alias_send_denied}

  def filter({:payload_exit, _from, _to}, _message), do: {:error, :exit_signal_denied}

  def filter({:payload_exit_tt, _from, _to, _trace_token}, _message),
    do: {:error, :exit_signal_denied}

  def filter({:payload_exit2, _from, _to}, _message), do: {:error, :exit_signal_denied}

  def filter({:payload_exit2_tt, _from, _to, _trace_token}, _message),
    do: {:error, :exit_signal_denied}

  def filter({:payload_monitor_p_exit, _from, _to, _ref}, _message), do: {:error, :monitor_denied}

  def filter({:spawn_request, _ref, _from, _group_leader, _mfa}, _args),
    do: {:error, :spawn_denied}

  def filter({:spawn_request_tt, _ref, _from, _group_leader, _mfa, _token}, _args),
    do: {:error, :spawn_denied}

  def filter(_control_message, _message), do: {:error, :raw_distribution_denied}

  @impl TCPFilter.Filter
  def filter(:tick), do: :ok
  def filter({:monitor_p, _from, _target, _ref}), do: {:error, :monitor_denied}
  def filter({:demonitor_p, _from, _target, _ref}), do: {:error, :monitor_denied}
  def filter({:monitor_p_exit, _target, _from, _reason}), do: {:error, :monitor_denied}
  def filter({:link, _from, _to}), do: {:error, :link_denied}
  def filter({:unlink, _from, _to}), do: {:error, :link_denied}
  def filter({:unlink_id, _id, _from, _to}), do: {:error, :link_denied}
  def filter({:unlink_id_ack, _id, _from, _to}), do: {:error, :link_denied}
  def filter({:exit, _from, _to, _reason}), do: {:error, :exit_signal_denied}
  def filter({:exit2, _from, _to, _reason}), do: {:error, :exit_signal_denied}
  def filter({:exit_tt, _from, _to, _reason, _trace_token}), do: {:error, :exit_signal_denied}
  def filter({:exit2_tt, _from, _to, _reason, _trace_token}), do: {:error, :exit_signal_denied}
  def filter({:group_leader, _from, _to}), do: {:error, :group_leader_denied}
  def filter({:node_link}), do: {:error, :node_link_denied}
  def filter(_control_message), do: {:error, :raw_distribution_denied}

  defp filter_gateway_message(message) do
    case Message.decode(message) do
      {:ok, _request} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end
end
