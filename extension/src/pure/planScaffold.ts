import * as fs from 'node:fs';
import * as path from 'node:path';

export const WIKI_PLAN_TEMPLATE = `version: 1

repowiki:
  template: ""           # "architecture" | "product_requirement" | ""
  notes:                 # guidance injected into planning prompts
    # - text: "Focus on business workflows rather than code details"
    #   author: "your-name"
  documents:             # strict page allowlist (one parent level only)
    # - title: "System Architecture Overview"
    #   goal: "Describe modules and interactions"
    # - title: "Order System"
    #   goal: "Explain the order lifecycle"
    #   parent: "System Architecture Overview"
    #   hints: "Include the payment flow"

knowledgecard:
  notes: []
    # - text: "Focus on the payment and order modules"

scope:
  include: []            # gitignore-style globs, e.g. "src/**"
  exclude: []            # e.g. "**/test/**"
`;

export function scaffoldPlan(repoRoot: string): string {
  const file = path.join(repoRoot, 'wiki_plan.yaml');
  if (!fs.existsSync(file)) fs.writeFileSync(file, WIKI_PLAN_TEMPLATE);
  return file;
}
