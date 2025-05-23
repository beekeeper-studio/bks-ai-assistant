import { defineStore } from "pinia";
import { STORAGE_KEYS } from "./config";
import { IModel } from "./types";
import _ from "lodash";
import { createProvider, ProviderId } from "./providers/modelFactory";
import showdown from "showdown";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import sql from "highlight.js/lib/languages/sql";
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { BaseModelProvider, BaseProvider } from "./providers/BaseModelProvider";

interface Tool {
  name: string;
  args: any;
  asksPermission: boolean;
  permissionResponse?: "accept" | "reject";
  permissionResolved: boolean;
}

interface ProviderState {
  providerId: ProviderId;
  apiKey: string;
  provider?: BaseProvider;
  model?: BaseModelProvider;
  models: IModel[];
  messages: BaseMessage[];
  isThinking: boolean;
  isCallingTool: boolean;
  activeTool: Tool | null;
  tools: Record<string, Tool>;
  error: unknown;
}

hljs.registerLanguage("sql", sql);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);

showdown.extension("highlight", function () {
  return [
    {
      type: "output",
      filter: function (text, converter, options) {
        var left = "<pre><code\\b[^>]*>",
          right = "</code></pre>",
          flags = "g";
        var replacement = function (wholeMatch, match, left, right) {
          var lang = (left.match(/class=\"([^ \"]+)/) || [])[1];
          left = left.slice(0, -1) + ` data-lang="${lang}"` + left.slice(-1);
          if (lang && hljs.getLanguage(lang)) {
            return left + hljs.highlight(lang, match).value + right;
          } else {
            return left + hljs.highlightAuto(match).value + right;
          }
        };
        return showdown.helper.replaceRecursiveRegExp(
          text,
          replacement,
          left,
          right,
          flags,
        );
      },
    },
  ];
});

// the first argument is a unique id of the store across your application
export const useProviderStore = defineStore("providers", {
  state: (): ProviderState => ({
    providerId:
      (localStorage.getItem(STORAGE_KEYS.PROVIDER) as ProviderId) || "claude",
    apiKey: localStorage.getItem(STORAGE_KEYS.API_KEY) || "",
    provider: undefined,
    models: [],
    messages: [],
    isThinking: false,
    isCallingTool: false,
    activeTool: null,
    tools: {},
    error: null,
  }),
  actions: {
    async initializeProvider() {
      try {
        this.provider = await createProvider(
          this.providerId,
          this.apiKey,
        );
        this.models = this.provider.models;
        let modelId = this.models[0].id;
        const storedModelId = localStorage.getItem(STORAGE_KEYS.MODEL);
        if (storedModelId && storedModelId.startsWith(`${this.providerId}:`)) {
          modelId = storedModelId.split(":")[1];
        }
        this.setModel(modelId);
        if (this.messages.length === 0) {
          this.messages.push(
            new SystemMessage(
              "Hi there! I'm your AI-powered assistant. How can I help you today?",
            ),
          );
        }
      } catch (e) {
        console.error(e);
        this.error = e;
        throw e;
      }
    },
    sendStreamMessage(message: string): Promise<void> {
      if (!this.provider) {
        throw new Error("No provider initialized");
      }

      this.isThinking = true;

      this.messages.push(new HumanMessage(message));

      let aiMessageIndex = -1;

      return new Promise<void>((resolve, reject) => {
        this.model!.sendStreamMessage(message, this.messages.slice(0, -1), {
          onStart: async () => {
            aiMessageIndex = -1;
          },
          onStreamChunk: async (message) => {
            if (aiMessageIndex === -1) {
              this.messages.push(message);
              aiMessageIndex = this.messages.length - 1;
            } else {
              this.messages[aiMessageIndex] = message;
            }

            this.messages = [...this.messages];
          },
          onBeforeToolCall: async (name, args) => {
            this.activeTool = {
              name,
              args,
              asksPermission: false,
              permissionResolved: false,
            }
          },
          onRequestToolPermission: async () => {
            this.activeTool!.asksPermission = true;
            this.isThinking = false;
            const permissionResponse = await new Promise<"accept" | "reject">((resolve) => {
              const unsubscribe = this.$subscribe((_mutation, state) => {
                if (state.activeTool?.permissionResponse) {
                  unsubscribe();
                  resolve(state.activeTool.permissionResponse);
                }
              });
            });
            this.activeTool!.permissionResponse = permissionResponse;
            this.activeTool!.permissionResolved = true;
            return permissionResponse === "accept";
          },
          onToolMessage: async (message) => {
            this.messages.push(message);
            this.tools[this.messages.length - 1] = this.activeTool!;
            this.activeTool = null;
            this.isThinking = true;
          },
          onFinalized: (messages) => {
            this.isThinking = false;
            this.messages = messages;
            resolve();
          },
          onError: (error) => {
            this.isThinking = false;
            this.isCallingTool = false;
            if (error instanceof Error && (error.message.startsWith("Aborted") || error.message.startsWith("AbortError"))) {
              resolve();
            } else {
              console.error(error);
              this.error = error;
              reject(error);
            }
          },
        })
      });
    },
    stopStreamMessage(): void {
      if (!this.model) {
        throw new Error("No model created");
      }

      this.model.abortStreamMessage();
    },
    setProviderId(providerId: ProviderId) {
      this.providerId = providerId;
      localStorage.setItem(STORAGE_KEYS.PROVIDER, providerId);
    },
    setApiKey(apiKey: string) {
      this.apiKey = apiKey;
      localStorage.setItem(STORAGE_KEYS.API_KEY, apiKey);
    },
    setModel(modelId: string) {
      if (this.model?.isSendingMessage) {
        throw new Error("Cannot switch model while a message is being sent.");
      }

      try {
        this.model = this.provider?.createModel({ modelId });
        localStorage.setItem(STORAGE_KEYS.MODEL, `${this.providerId}:${modelId}`);
        console.log(`Switched to model: ${modelId}`);
      } catch (e) {
        console.error(e);
        throw e;
      }
    },
  },
});
