import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";

export function Markdown({ content, small = false }: { content: string; small?: boolean }) {
  return (
    <div className={`note ${small ? "note-sm" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug, [rehypeHighlight, { ignoreMissing: true }]]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
