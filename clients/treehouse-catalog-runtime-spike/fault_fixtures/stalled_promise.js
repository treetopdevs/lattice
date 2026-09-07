// Private test-only fault fixture. A promise that never resolves and leaves
// no pending job: must be failure, never successful empty output.
new Promise(function () {})
