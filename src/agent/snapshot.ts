import type { BossQueryContext, PageSnapshot, SnapshotElement, SnapshotRegion } from "../types";

let snapshotSeq = 0;
export function newSnapshotId(): string {
  snapshotSeq += 1;
  return `snap_${Date.now().toString(36)}_${snapshotSeq}`;
}

const CHIP_DIM: Array<[RegExp, keyof BossQueryContext]> = [
  [/薪资|薪水/, "salary"],
  [/经验/, "experience"],
  [/学历/, "education"],
  [/城市|地点/, "location"],
  [/求职类型|工作性质/, "jobTypes"],
  [/公司行业|行业/, "industries"],
  [/公司规模|规模/, "companySizes"]
];

export function classifyChip(text: string): keyof BossQueryContext | null {
  const t = (text || "").trim();
  for (const [re, dim] of CHIP_DIM) if (re.test(t)) return dim;
  return null;
}

export function serializeSnapshotForLLM(snap: PageSnapshot): string {
  const line = (e: SnapshotElement): string => {
    const parts = [`[e${e.id}]`, e.role, `"${e.text}"`];
    if (e.current) parts.push(`cur="${e.current}"`);
    if (e.checked) parts.push("✓");
    if (e.hint) parts.push(`hint="${e.hint}"`);
    parts.push(`@${e.region}`);
    return parts.join(" ");
  };
  return snap.elements.map(line).join("\n");
}

// resolveRef / snapshotPage 在 Task 3 实现；这里预留导出占位以保持文件职责单一。
