import "@radix-ui/themes/styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Theme accentColor="blue" grayColor="slate" radius="medium" scaling="95%">
      <App />
    </Theme>
  </React.StrictMode>,
);
