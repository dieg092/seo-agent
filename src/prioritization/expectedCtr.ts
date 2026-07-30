// src/prioritization/expectedCtr.ts
// Curva de CTR esperado por posición media, definida en docs/ (sección "MÉTRICAS
// QUE DEBES CALCULAR"). Es solo un punto de partida; se recalibra con el histórico
// real de miwebdeboda.com según vaya habiendo más datos.
const CTR_CURVE: [maxPosition: number, ctr: number][] = [
  [1, 0.27],
  [2, 0.16],
  [3, 0.11],
  [4, 0.08],
  [5, 0.06],
  [6, 0.05],
  [7, 0.04],
  [8, 0.035],
  [9, 0.03],
  [10, 0.025],
  [15, 0.015],
  [20, 0.01],
  [30, 0.005],
];

export function expectedCtrForPosition(position: number): number {
  for (const [maxPosition, ctr] of CTR_CURVE) {
    if (position <= maxPosition) return ctr;
  }
  return CTR_CURVE[CTR_CURVE.length - 1][1];
}
