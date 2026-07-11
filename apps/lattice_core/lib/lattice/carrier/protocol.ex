defmodule Lattice.Carrier.Protocol do
  @moduledoc """
  Typed vocabulary for carrier request and response frames.

  This module validates JSON frame shape only. Op decoding remains in
  `Lattice.Carrier.Wire`, and accepted ops still reach `Lattice.Log.accept/2`
  exclusively through `Lattice.Sync.deliver/2`.
  """

  alias Lattice.Carrier.Wire

  @request_types ~w(frontier pull push live status state shutdown)

  @type encoded_op :: map()
  @type request ::
          :frontier
          | {:pull, [String.t()]}
          | {:push, [encoded_op()]}
          | {:live, term()}
          | :status
          | :state
          | :shutdown
  @type decode_error :: :malformed_request | :unknown_type
  @type response_error ::
          {:peer_error, term()} | {:unexpected_reply, term()} | :malformed_response

  @doc "Build a frontier-advertisement request."
  @spec frontier_request() :: map()
  def frontier_request, do: %{"type" => "frontier"}

  @doc "Build a pull request from the caller's sorted op-id set."
  @spec pull_request(Enumerable.t()) :: map()
  def pull_request(have), do: %{"type" => "pull", "have" => Enum.sort(have)}

  @doc "Build a push request around already encoded op frames."
  @spec push_request([encoded_op()]) :: map()
  def push_request(encoded_ops) when is_list(encoded_ops),
    do: %{"type" => "push", "ops" => encoded_ops}

  @doc "Build an ephemeral live-message request."
  @spec live_request(term()) :: map()
  def live_request(payload), do: %{"type" => "live", "payload" => payload}

  @doc "Build a peer-phase request."
  @spec status_request() :: map()
  def status_request, do: %{"type" => "status"}

  @doc "Build a peer-state report request."
  @spec state_request() :: map()
  def state_request, do: %{"type" => "state"}

  @doc "Build a graceful peer-shutdown request."
  @spec shutdown_request() :: map()
  def shutdown_request, do: %{"type" => "shutdown"}

  @doc "Decode one authenticated carrier request without interpreting op contents."
  @spec decode_request(map()) :: {:ok, request()} | {:error, decode_error()}
  def decode_request(%{"type" => "frontier"}), do: {:ok, :frontier}

  def decode_request(%{"type" => "pull", "have" => have}) when is_list(have) do
    if Enum.all?(have, &is_binary/1),
      do: {:ok, {:pull, have}},
      else: {:error, :malformed_request}
  end

  def decode_request(%{"type" => "push", "ops" => encoded_ops}) when is_list(encoded_ops),
    do: {:ok, {:push, encoded_ops}}

  def decode_request(%{"type" => "live", "payload" => payload}),
    do: {:ok, {:live, payload}}

  def decode_request(%{"type" => "status"}), do: {:ok, :status}
  def decode_request(%{"type" => "state"}), do: {:ok, :state}
  def decode_request(%{"type" => "shutdown"}), do: {:ok, :shutdown}

  def decode_request(%{"type" => type}) when type in @request_types,
    do: {:error, :malformed_request}

  def decode_request(%{"type" => type}) when is_binary(type), do: {:error, :unknown_type}
  def decode_request(_frame), do: {:error, :malformed_request}

  @doc "Build a sorted frontier response."
  @spec frontier_result(Enumerable.t()) :: map()
  def frontier_result(ids), do: %{"type" => "frontier_result", "ids" => Enum.sort(ids)}

  @doc "Build a pull response around already encoded op frames."
  @spec ops_result([encoded_op()]) :: map()
  def ops_result(encoded_ops) when is_list(encoded_ops),
    do: %{"type" => "ops", "ops" => encoded_ops}

  @doc "Build a push response from a `Lattice.Sync` delivery report."
  @spec push_result(Lattice.Sync.report()) :: map()
  def push_result(report) do
    report
    |> Wire.encode_report()
    |> Map.put("type", "push_result")
  end

  @doc "Build an ephemeral-delivery response."
  @spec live_result(map()) :: map()
  def live_result(result) when is_map(result),
    do: result |> string_keys() |> Map.put("type", "live_result")

  @doc "Build a peer-phase response."
  @spec status_result(String.t()) :: map()
  def status_result(phase) when is_binary(phase),
    do: %{"type" => "status_result", "phase" => phase}

  @doc "Build a peer-state response without interpreting report contents."
  @spec state_result(map()) :: map()
  def state_result(report) when is_map(report),
    do: report |> string_keys() |> Map.put("type", "state_result")

  @doc "Build a graceful-shutdown acknowledgement."
  @spec shutdown_result() :: map()
  def shutdown_result, do: %{"type" => "shutdown_result"}

  @doc "Build a protocol error response."
  @spec error(atom() | String.t()) :: map()
  def error(reason), do: %{"type" => "error", "reason" => to_string(reason)}

  @doc "Decode the peer op-id response."
  @spec decode_frontier_result(map()) :: {:ok, [String.t()]} | {:error, response_error()}
  def decode_frontier_result(%{"type" => "frontier_result", "ids" => ids})
      when is_list(ids) do
    if Enum.all?(ids, &is_binary/1), do: {:ok, ids}, else: {:error, :malformed_response}
  end

  def decode_frontier_result(%{"type" => "frontier_result"}),
    do: {:error, :malformed_response}

  def decode_frontier_result(frame), do: unexpected_response(frame)

  @doc "Decode a pull response without interpreting individual op frames."
  @spec decode_ops_result(map()) :: {:ok, [encoded_op()]} | {:error, response_error()}
  def decode_ops_result(%{"type" => "ops", "ops" => encoded_ops}) when is_list(encoded_ops),
    do: {:ok, encoded_ops}

  def decode_ops_result(%{"type" => "ops"}), do: {:error, :malformed_response}
  def decode_ops_result(frame), do: unexpected_response(frame)

  @doc "Decode a push response and its delivery report."
  @spec decode_push_result(map()) ::
          {:ok, Lattice.Sync.report()} | {:error, response_error()}
  def decode_push_result(%{"type" => "push_result"} = frame) do
    case Wire.decode_report(frame) do
      {:ok, report} -> {:ok, report}
      {:error, _reason} -> {:error, :malformed_response}
    end
  end

  def decode_push_result(frame), do: unexpected_response(frame)

  @doc "Decode an ephemeral-delivery acknowledgement."
  @spec decode_live_result(map()) :: :ok | {:error, response_error()}
  def decode_live_result(%{"type" => "live_result"}), do: :ok
  def decode_live_result(frame), do: unexpected_response(frame)

  @doc "Decode a peer-phase response."
  @spec decode_status_result(map()) :: {:ok, String.t()} | {:error, response_error()}
  def decode_status_result(%{"type" => "status_result", "phase" => phase})
      when is_binary(phase),
      do: {:ok, phase}

  def decode_status_result(%{"type" => "status_result"}),
    do: {:error, :malformed_response}

  def decode_status_result(frame), do: unexpected_response(frame)

  @doc "Decode a peer-state response while preserving its full report map."
  @spec decode_state_result(map()) :: {:ok, map()} | {:error, response_error()}
  def decode_state_result(%{"type" => "state_result"} = report), do: {:ok, report}
  def decode_state_result(frame), do: unexpected_response(frame)

  @doc "Decode a graceful-shutdown acknowledgement."
  @spec decode_shutdown_result(map()) :: {:ok, map()} | {:error, response_error()}
  def decode_shutdown_result(%{"type" => "shutdown_result"} = frame), do: {:ok, frame}
  def decode_shutdown_result(frame), do: unexpected_response(frame)

  @doc "Convert a received envelope-level error into the carrier error contract."
  @spec decode_response_envelope(term()) :: {:ok, map()} | {:error, response_error()}
  def decode_response_envelope(%{"type" => "error", "reason" => reason}),
    do: {:error, {:peer_error, reason}}

  def decode_response_envelope(%{} = frame), do: {:ok, frame}
  def decode_response_envelope(_frame), do: {:error, :malformed_response}

  defp unexpected_response(%{"type" => "error", "reason" => reason}),
    do: {:error, {:peer_error, reason}}

  defp unexpected_response(%{"type" => type}), do: {:error, {:unexpected_reply, type}}
  defp unexpected_response(other), do: {:error, {:unexpected_reply, other}}

  defp string_keys(map) do
    Map.new(map, fn {key, value} -> {to_string(key), value} end)
  end
end
