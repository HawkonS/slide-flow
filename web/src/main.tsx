import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { installChunkLoadRecovery } from "./lib/chunk-recovery";
import { installDeploymentRecovery } from "./lib/deployment-recovery";
import "./styles/globals.css";

installChunkLoadRecovery();
installDeploymentRecovery();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
