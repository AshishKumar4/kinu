import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { inCapScope } from "./no-output-token-cap.ts";

/**
 * Bases whose Durable Object alarm slot the agents SDK owns. Its `_scheduleNextAlarm()` deletes an
 * alarm it did not set, and its `alarm()` runs the schedule table, so a subclass that shadows
 * `alarm()` or writes the slot itself stops every scheduled wake without an error anywhere.
 */
const SDK_SCHEDULED_BASES = new Set(["Agent", "AIChatAgent", "Think", "ActorAgent", "OrchestratorAgent"]);

const ALARM_WRITERS = new Set(["setAlarm", "deleteAlarm"]);

interface ClassFrame {
  /** The SDK-scheduled base it extends, or `null` when it extends none. */
  readonly base: string | null;
}

interface AlarmFrame {
  readonly node: ESTree.Node;
  readonly base: string;
  chained: boolean;
}

/**
 * Keep the SDK's alarm chain intact: an `alarm` declared on a class over an SDK-scheduled base must
 * call `super.alarm()`, and a file that declares such a class must not write the alarm slot. A
 * plain `DurableObject` owns its own slot and is outside the rule. The match is syntactic, so a
 * comment or string naming `super.alarm()` does not satisfy it.
 */
export const requireSuperAlarmRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require SDK-scheduled Durable Objects to chain alarm() to super and leave the alarm slot to the SDK.",
    },
    messages: {
      shadowedAlarm:
        "`alarm` on a class over `{{base}}` must call `super.alarm()`: the SDK runs every scheduled wake from it, and a shadowed alarm stops them all silently.",
      directAlarm:
        "`{{method}}` writes the alarm slot the agents SDK owns in this file; its scheduler deletes alarms it did not set. Schedule through `this.schedule`.",
    },
  },
  createOnce(context) {
    let inScope = false;
    let fileHostsSdkClass = false;
    let classes: ClassFrame[] = [];
    let alarms: AlarmFrame[] = [];
    let writers: { readonly node: ESTree.CallExpression; readonly method: string }[] = [];

    const enterClass = (node: ESTree.Class): void => {
      const name = node.superClass?.type === "Identifier" ? node.superClass.name : undefined;
      const base = name !== undefined && SDK_SCHEDULED_BASES.has(name) ? name : null;

      if (base !== null) fileHostsSdkClass = true;
      classes.push({ base });
    };

    const exitClass = (): void => { classes.pop(); };

    const enterMember = (node: ESTree.MethodDefinition | ESTree.PropertyDefinition): void => {
      const base = classes.at(-1)?.base ?? null;

      if (!inScope || base === null || node.computed || node.static) return;

      if (node.key.type !== "Identifier" || node.key.name !== "alarm") return;

      if (node.type === "PropertyDefinition") {
        const value = node.value;

        if (value?.type !== "ArrowFunctionExpression" && value?.type !== "FunctionExpression") return;
      }

      alarms.push({ node, base, chained: false });
    };

    const exitMember = (node: ESTree.MethodDefinition | ESTree.PropertyDefinition): void => {
      const frame = alarms.at(-1);

      if (frame?.node !== node) return;
      alarms.pop();

      if (!frame.chained) context.report({ node, messageId: "shadowedAlarm", data: { base: frame.base } });
    };

    return {
      Program() {
        inScope = inCapScope(context.filename);
        fileHostsSdkClass = false;
        classes = [];
        alarms = [];
        writers = [];
      },
      ClassDeclaration: enterClass,
      "ClassDeclaration:exit": exitClass,
      ClassExpression: enterClass,
      "ClassExpression:exit": exitClass,
      MethodDefinition: enterMember,
      "MethodDefinition:exit": exitMember,
      PropertyDefinition: enterMember,
      "PropertyDefinition:exit": exitMember,
      CallExpression(node) {
        if (!inScope || node.callee.type !== "MemberExpression" || node.callee.computed) return;
        const { object, property } = node.callee;

        if (property.type !== "Identifier") return;

        if (object.type === "Super" && property.name === "alarm") {
          const frame = alarms.at(-1);

          if (frame !== undefined) frame.chained = true;

          return;
        }

        if (ALARM_WRITERS.has(property.name)) writers.push({ node, method: property.name });
      },
      "Program:exit"() {
        if (!fileHostsSdkClass) return;

        for (const { node, method } of writers) context.report({ node, messageId: "directAlarm", data: { method } });
      },
    };
  },
});
