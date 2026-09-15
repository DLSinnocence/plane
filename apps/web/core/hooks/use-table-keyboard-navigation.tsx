/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

const getAdjacentRow = (element: HTMLElement, direction: "previous" | "next") => {
  let row = element.closest("tr");
  while (row) {
    const section = row.parentElement;
    let adjacent = direction === "previous" ? row.previousElementSibling : row.nextElementSibling;
    if (!adjacent) {
      // Keep navigation between the header and body when skipping boundary rows.
      const adjacentSection = direction === "previous" ? section?.previousElementSibling : section?.nextElementSibling;
      if (direction === "previous" && section?.tagName === "TBODY" && adjacentSection?.tagName === "THEAD") {
        adjacent = adjacentSection.lastElementChild;
      } else if (direction === "next" && section?.tagName === "THEAD" && adjacentSection?.tagName === "TBODY") {
        adjacent = adjacentSection.firstElementChild;
      }
    }
    if (!adjacent || adjacent.tagName !== "TR") return null;
    if (adjacent.getAttribute("data-skip-keyboard-navigation") !== "true") return adjacent;
    row = adjacent as HTMLTableRowElement;
  }
  return null;
};

export const useTableKeyboardNavigation = () => {
  const handleKeyBoardNavigation = function (e: React.KeyboardEvent<HTMLTableElement>) {
    const element = e.target as HTMLElement;

    if (!(element?.tagName === "TD" || element?.tagName === "TH")) return;

    let c: HTMLElement | null = null;
    if (e.key == "ArrowRight") {
      // Right Arrow
      c = element.nextSibling as HTMLElement;
    } else if (e.key == "ArrowLeft") {
      // Left Arrow
      c = element.previousSibling as HTMLElement;
    } else if (e.key == "ArrowUp" || e.key == "ArrowDown") {
      const index = Array.prototype.indexOf.call(element.parentElement?.children || [], element);
      const row = getAdjacentRow(element, e.key === "ArrowUp" ? "previous" : "next");
      c = row?.children[index] as HTMLElement;
    } else if (e.key == "Enter" || e.key == "Space") {
      e.preventDefault();
      (element?.querySelector(".clickable") as HTMLElement)?.click();
      return;
    }

    if (!c) return;

    e.preventDefault();
    c?.focus();
    c?.scrollIntoView({ behavior: "smooth", block: "center", inline: "end" });
  };

  return handleKeyBoardNavigation;
};
