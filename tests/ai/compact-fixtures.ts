/** Synthetic, self-contained evidence cases; no business repository is sent to the model. */
export function compactFixture(scenario: string) {
  if (!["imports-defects", "resources-defects", "evidence-clean"].includes(scenario)) return undefined;
  const baseline: Record<string, string> = {};
  const changedFiles: string[] = [];
  if (scenario !== "resources-defects") {
    Object.assign(baseline, {
      "messages.py": "class FitReq:\n    pass\n\nclass FitReply:\n    pass\n",
      "messages_t.py": "class FitTReq:\n    pass\n\nclass FitTReply:\n    pass\n",
      "api.py": "from messages import FitReq, FitReply\n\nSERVICE_NAME = 'AlgorithmService'\n\ndef health():\n    return True\n\ndef FitLine(request: FitReq) -> FitReply:\n    result = FitReply()\n    return result\n",
      "main.py": "from api import FitLine\nfrom messages import FitReq\n\nif __name__ == '__main__':\n    print(FitLine(FitReq()))\n",
      "pyproject.toml": '[project]\nname = "synthetic-service"\nversion = "0.0.0"\nrequires-python = ">=3.11,<3.12"\n',
    });
    changedFiles.push("api.py");
  }
  if (scenario !== "imports-defects") {
    Object.assign(baseline, {
      "DatProcess.cpp": '#include <cstdint>\n#include <cstddef>\n#include <string>\n#include <unordered_map>\nusing Data = std::unordered_map<std::string, void*>;\n\nData read() {\n    Data result;\n    result["phase_data_size"] = new size_t(128);\n    return result;\n}\n\nvoid cleanup(Data& data) {\n    for (auto& [key, value] : data) {\n        if (key == "phase_data_size") {\n            delete static_cast<size_t*>(value);\n        }\n    }\n    data.clear();\n}\n\nint main() {\n    for (int i = 0; i < 1000; ++i) {\n        auto data = read();\n        cleanup(data);\n    }\n}\n',
    });
    changedFiles.push("DatProcess.cpp");
  }
  return { baseline, changedFiles, change(file: string, body: string) {
    if (scenario === "evidence-clean") return body + (file.endsWith(".cpp") ? "//" : "#") + " Preserve behavior.\n";
    if (scenario === "imports-defects") return body.replace("from messages import", "from messages_t import").replace("result = FitReply()", "result = FitTReply()");
    return body.replace('    return result;', '    result["image_width"] = new uint32_t(640);\n    result["image_height"] = new uint32_t(480);\n    return result;');
  } };
}
