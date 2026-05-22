"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

type PaginationProps = {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
};

export function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  pageSizeOptions = [10, 20, 50],
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  const safeTotalPages = Math.max(1, totalPages || 1);
  const safePage = Math.min(Math.max(1, page || 1), safeTotalPages);
  const start = totalItems > 0 ? (safePage - 1) * (pageSize || 1) + 1 : 0;
  const end = totalItems > 0 ? Math.min(safePage * (pageSize || 1), totalItems) : 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-4 mt-4 border-t border-[var(--border)]">
      <div className="text-xs text-slate-500">
        {totalItems > 0 ? `Mostrando ${start}-${end} de ${totalItems}` : "Sin resultados"}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange && pageSize && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="input h-9 w-24 text-xs"
            title="Cantidad por página"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}/p
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, safePage - 1))}
          disabled={safePage <= 1}
          className="btn-ghost h-9 px-3 text-xs disabled:opacity-50"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          Anterior
        </button>
        <span className="text-xs text-slate-500 px-2">
          Página {safePage} / {safeTotalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(safeTotalPages, safePage + 1))}
          disabled={safePage >= safeTotalPages}
          className="btn-ghost h-9 px-3 text-xs disabled:opacity-50"
        >
          Siguiente
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
