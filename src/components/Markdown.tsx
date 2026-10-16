import { isValidElement, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";
import { TaskCheckbox } from "./ProgressControls";
import { CodeBlock, TableWrap, ZoomImage } from "./note/NoteParts";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
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

function textOf(n: HastNode | undefined): string {
  if (!n) return "";
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(textOf).join("");
}

/**
 * 인용문을 첫 문단의 접두어로 분류한다 (노트들이 실제로 쓰는 표현 기준).
 *   주의·함정·경고·위험 → warn / 팁·조합 → tip / 핵심·결론·요약 → key / 더 깊이·함께 읽기·다음 → link / 따옴표로 시작 → quote
 */
function calloutKind(node: HastNode | undefined): string | undefined {
  const firstP = node?.children?.find((c) => c.type === "element" && c.tagName === "p");
  const text = textOf(firstP).trim();
  if (/^["“]/.test(text)) return "quote";
  const label = /^([^:：\n]{1,14})[:：]/.exec(text)?.[1] ?? "";
  if (/주의|함정|경고|위험|금지/.test(label)) return "warn";
  if (/팁|조합|요령/.test(label)) return "tip";
  if (/핵심|결론|요약|정리/.test(label)) return "key";
  if (/더 깊이|함께 읽기|다음|참고/.test(label)) return "link";
  return undefined;
}

function langOf(children: ReactNode): string | undefined {
  if (!isValidElement<{ className?: string }>(children)) return undefined;
  const m = /language-([\w+-]+)/.exec(children.props.className ?? "");
  return m?.[1];
}

interface Props {
  content: string;
  small?: boolean;
  /** 지정하면 체크리스트(- [ ])가 저장되는 체크박스가 된다 */
  checklist?: { subject: string; slug: string; checked: number[] };
}

type WithNode<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T> & { node?: HastNode };

export function Markdown({ content, small = false, checklist }: Props) {
  const components = {
    pre: ({ node, children, ...rest }: WithNode<"pre">) => {
      void node;
      return (
        <CodeBlock lang={langOf(children)} {...rest}>
          {children}
        </CodeBlock>
      );
    },
    table: ({ node, children }: WithNode<"table">) => {
      void node;
      return <TableWrap>{children}</TableWrap>;
    },
    img: ({ node, src, alt }: WithNode<"img">) => {
      void node;
      return <ZoomImage src={typeof src === "string" ? src : undefined} alt={alt} />;
    },
    blockquote: ({ node, children, ...rest }: WithNode<"blockquote">) => {
      const kind = calloutKind(node);
      return (
        <blockquote {...rest} data-callout={kind}>
          {children}
        </blockquote>
      );
    },
    ...(checklist
      ? {
          input: ({ node, ...props }: WithNode<"input"> & { "data-line"?: number | string }) => {
            void node;
            if (props.type !== "checkbox") return <input {...props} />;
            const line = Number(props["data-line"] ?? -1);
            return <TaskCheckbox subject={checklist.subject} slug={checklist.slug} line={line} initial={checklist.checked.includes(line) || !!props.checked} />;
          },
        }
      : {}),
  };
  return (
    <div className={`note ${small ? "note-sm" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug, rehypeCheckboxLines, [rehypeHighlight, { ignoreMissing: true }]]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
