let componentCounter = 0;

export function getUniqueTestComponent(base) {
  componentCounter++;
  return `${base}_${process.pid}_${componentCounter}`;
}
