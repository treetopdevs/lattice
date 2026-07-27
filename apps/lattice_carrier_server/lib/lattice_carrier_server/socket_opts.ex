defmodule LatticeCarrierServer.SocketOpts do
  @moduledoc false

  @spec build(:inet.ip_address(), :inet.port_number()) :: [:gen_tcp.listen_option()]
  def build({_a, _b, _c, _d, _e, _f, _g, _h} = ip, port),
    do: [:inet6, ip: ip, port: port]

  def build(ip, port), do: [ip: ip, port: port]
end
