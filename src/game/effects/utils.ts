/**
 * 이펙트 공통 유틸리티
 */

/**
 * 배열 중간 요소를 O(1)로 제거 (순서 보존 X).
 * 역순 for 루프에서 사용하면 안전 — swap된 새 요소는 이미 이전 iteration에서 처리 완료.
 *
 * 기존 `arr.splice(i, 1)` (O(N) 시프트)를 대체.
 */
export function swapPop<T>(arr: T[], i: number): void {
  const last = arr.length - 1;
  if (i !== last) arr[i] = arr[last];
  arr.pop();
}
