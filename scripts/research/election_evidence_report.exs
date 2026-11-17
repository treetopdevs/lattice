# Row 156 research harness: render the election evidence report from a
# test-only fixture bundle.
#
#   MIX_ENV=test mix do compile, run scripts/research/election_evidence_report.exs
#
# The fixture ballots are opaque bytes. Nothing here models a real election, and
# the report makes no security claim.

unless Code.ensure_loaded?(Township.ElectionReportFixture) do
  raise "run with MIX_ENV=test (research fixture)"
end

IO.puts(
  "RESEARCH HARNESS: opaque fixture ballots, no security claim, legacy Attestation.Stub unchanged"
)

dir = "tmp/election_report"
bundle_path = Path.join(dir, "bundle.etf")
out_path = Path.join(dir, "report.html")

scenario = Township.ElectionReportFixture.close_scenario()
File.mkdir_p!(dir)
File.write!(bundle_path, Township.ElectionReportFixture.bundle_bytes(scenario))

Mix.Task.run("lattice.election.report", [
  "--bundle",
  bundle_path,
  "--out",
  out_path,
  "--open-certificate",
  scenario.open_certificate_id
])

IO.puts("""
Rerun against any bundle with:
  mix lattice.election.report --bundle #{bundle_path} --out #{out_path} --open-certificate #{scenario.open_certificate_id}
""")
