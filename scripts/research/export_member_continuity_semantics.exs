# MIX_ENV=test uses only synthetic test fixtures and writes a new semantic corpus.
[path] = System.argv()
Treehouse.MemberContinuitySemanticVectors.export!(path)
IO.puts("BEAM_MEMBER_CONTINUITY_SEMANTICS_EXPORTED")
