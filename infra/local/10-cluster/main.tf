# 1단계: kind 클러스터 자체를 코드로. (IaC 노트 07)
#   pnpm tf:cluster init && pnpm tf:cluster apply   → 컨텍스트 kind-<name>
#   두 번째 apply 는 "No changes" 여야 한다 (멱등).
variable "name" {
  description = "kind 클러스터 이름 (컨텍스트는 kind-<name>)"
  type        = string
  default     = "study-tf"
}

variable "node_image" {
  type    = string
  default = "kindest/node:v1.31.2"
}

variable "workers" {
  description = "워커 노드 수"
  type        = number
  default     = 0
}

resource "kind_cluster" "this" {
  name           = var.name
  node_image     = var.node_image
  wait_for_ready = true

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    node {
      role = "control-plane"
    }

    dynamic "node" {
      for_each = range(var.workers)
      content {
        role = "worker"
      }
    }
  }
}

output "name" { value = kind_cluster.this.name }
output "context" { value = "kind-${kind_cluster.this.name}" }
output "endpoint" { value = kind_cluster.this.endpoint }
output "kubeconfig_path" {
  value     = kind_cluster.this.kubeconfig_path
  sensitive = false
}
