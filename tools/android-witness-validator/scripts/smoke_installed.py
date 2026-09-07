"""Exercise the installed launcher with disposable public issuance data, without device proof."""
import base64
import json
from pathlib import Path
import subprocess
import tempfile


def main():
    distribution = Path(__file__).resolve().parents[1] / "build/install/treehouse-android-witness-validator"
    executable = distribution / "bin/treehouse-android-witness-validator"
    binary = lambda value: base64.b64encode(bytes([value]) * 32).decode("ascii")
    expected = {
        "replica": "replica:installed-validator-probe",
        "enrollmentId": binary(1), "recipient": binary(2),
        "creationAttemptId": binary(3), "appSignerSha256": binary(4),
        "creationVersionCode": "1",
    }
    with tempfile.TemporaryDirectory(prefix="treehouse-validator-installed-") as directory:
        def invoke(command, body, identifiers=()):
            result = subprocess.run(
                [str(executable), directory, command, *identifiers],
                input=body, capture_output=True, timeout=30, check=True,
            )
            return json.loads(result.stdout)

        issued = invoke("issue-generation", json.dumps({
            "version": 1, "kind": "issue_generation", "expected": expected,
        }).encode("utf-8"))
        assert issued["status"] == "issued"
        assert set(issued["uiRequest"]) == {"creationAttemptId", "generationChallenge"}
        assert issued["uiRequest"]["creationAttemptId"] == expected["creationAttemptId"]
        assert len(base64.b64decode(issued["uiRequest"]["generationChallenge"], validate=True)) == 32
        refused = invoke("verify-generation", b"{}", [issued["issuanceId"]])
        assert refused["status"] == "refused"
        assert not (Path(directory) / "official-trust").exists()
    print("PASS installed validator issuance, exact UI request, separate-process refusal; no device evidence")


if __name__ == "__main__":
    main()
