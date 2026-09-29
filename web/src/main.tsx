import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { installChunkLoadRecovery } from "./lib/chunk-recovery";
import { installDeploymentRecovery } from "./lib/deployment-recovery";
import { registerPwa } from "./lib/pwa";
import "./styles/globals.css";

installChunkLoadRecovery();
// Production updates are activated only after all windows close. Polling the
// entry HTML and forcing a reload would interrupt presentations and forms.
if (import.meta.env.DEV) installDeploymentRecovery();
registerPwa();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
