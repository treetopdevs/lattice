defmodule Treehouse.Invitation do
  @moduledoc "Recipient-owned acceptance evidence for one signed Space invitation."

  alias Lattice.{Canonical, Identity, Op}

  @domain "treehouse-invitation-acceptance-v1"

  @doc "Canonical acceptance binds the Space, signed invitation, recipient and exact Thread scope."
  @spec bytes(String.t(), Op.t()) :: binary()
  def bytes(replica, %Op{id: id, body: {:issue_invitation, [recipient, threads]}}) do
    Canonical.term([@domain, replica, id, recipient, threads])
  end

  @doc "Sign acceptance with the recipient's own identity; no signing key enters the invitation."
  @spec accept(Identity.t(), String.t(), Op.t()) :: String.t()
  def accept(%Identity{} = recipient, replica, invitation) do
    recipient |> Identity.sign(bytes(replica, invitation)) |> Base.encode64()
  end

  @doc "Verify the exact recipient's acceptance, refusing malformed evidence."
  @spec valid_acceptance?(String.t(), Op.t(), String.t()) :: boolean()
  def valid_acceptance?(
        replica,
        %Op{body: {:issue_invitation, [recipient, _]}} = invite,
        signature
      ) do
    with {:ok, pub} <- canonical_bytes(recipient, 32),
         {:ok, sig} <- canonical_bytes(signature, 64) do
      Identity.verify(pub, bytes(replica, invite), sig)
    else
      _ -> false
    end
  end

  def valid_acceptance?(_, _, _), do: false

  @doc false
  @spec recipient?(term()) :: boolean()
  def recipient?(value), do: match?({:ok, _}, canonical_bytes(value, 32))

  defp canonical_bytes(value, size) when is_binary(value) do
    with {:ok, bytes} <- Base.decode64(value),
         true <- byte_size(bytes) == size and Base.encode64(bytes) == value do
      {:ok, bytes}
    else
      _ -> :error
    end
  end

  defp canonical_bytes(_, _), do: :error
end
