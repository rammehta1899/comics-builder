import { formatPageNumber, type ComicPage } from "../types/comic";

interface Props {
  pages: ComicPage[];
  currentIndex: number;
  onSelect: (index: number) => void;
}

export default function PageRail({ pages, currentIndex, onSelect }: Props) {
  return (
    <nav className="page-rail" aria-label="Pages">
      {pages.map((page, i) => (
        <button
          key={page.id}
          className={`page-rail-item${i === currentIndex ? " active" : ""}`}
          onClick={() => onSelect(i)}
          aria-current={i === currentIndex ? "page" : undefined}
        >
          <span className="page-rail-number">{formatPageNumber(page.number)}</span>
          <span className="page-rail-title">{page.title}</span>
        </button>
      ))}
    </nav>
  );
}
