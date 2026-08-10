Application.put_env(:lattice_carrier_server, :allow_ephemeral_manifest_ports, true)

existing_exclusions = ExUnit.configuration()[:exclude] || []
ExUnit.start(exclude: Enum.uniq([:packaged_release | existing_exclusions]))
