export interface DesignToken {
  name: string;
  light: string;
  dark: string;
}

/** Read global theme declarations without maintaining a second token inventory. */
export function readDesignTokens(source: string): DesignToken[] {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  for (const rule of source.matchAll(/:root(\[data-theme="dark"\])?\s*\{([^}]+)\}/g)) {
    const declarations = rule[1] ? dark : light;
    for (const declaration of rule[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      declarations.set(declaration[1], declaration[2].trim());
    }
  }
  return [...new Set([...light.keys(), ...dark.keys()])].map((name) => ({
    name,
    light: light.get(name) ?? '',
    dark: dark.get(name) ?? light.get(name) ?? '',
  }));
}
