import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";
import { CodeBlock } from "./CodeBlock";
import { TaskCheckbox } from "./ProgressControls";

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number } };
  children?: HastNode[];
}

/** 체크박스 input 에 원본 markdown 줄 번호를 data-line 으로 붙인다 (저장 키로 사용) */
function rehypeCheckboxLines() {
  return (tree: HastNode) => {
    // remark-gfm 이 만드는 input 엔 position 이 없으므로 부모 li 의 줄 번호를 쓴다
    const walk = (n: HastNode, line?: number) => {
      const own = n.type === "element" && n.tagName === "li" && n.position ? n.position.start.line : line;
      if (n.type === "element" && n.tagName === "input" && own !== undefined) {
        n.properties = { ...(n.properties ?? {}), dataLine: own };
      }
      n.children?.forEach((c) => walk(c, own));
    };
    walk(tree);
  };
}

interface Props {
  content: string;
  small?: boolean;
  /** 지정하면 체크리스트(- [ ])가 저장되는 체크박스가 된다 */
  checklist?: { subject: string; slug: string; checked: number[] };
}

export function Markdown({ content, small = false, checklist }: Props) {
  const components = checklist
    ? {
        input: (props: ComponentProps<"input"> & { "data-line"?: number | string }) => {
          if (props.type !== "checkbox") return <input {...props} />;
          const line = Number(props["data-line"] ?? -1);
          return <TaskCheckbox subject={checklist.subject} slug={checklist.slug} line={line} initial={checklist.checked.includes(line) || !!props.checked} />;
        },
      }
    : undefined;
  return (
    <div className={`note ${small ? "note-sm" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug, rehypeCheckboxLines, [rehypeHighlight, { ignoreMissing: true }]]} components={{ ...components, pre: ({ children }) => <CodeBlock>{children}</CodeBlock>, table: ({ children }) => <div className="note-table-scroll"><table>{children}</table></div> }}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
