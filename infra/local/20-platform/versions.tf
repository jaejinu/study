terraform {
  required_version = ">= 1.6"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
  }
}

# 10-cluster 가 만든 컨텍스트를 쓴다 (원격 상태 대신 변수로 — 로컬 실습)
provider "kubernetes" {
  config_path    = var.kubeconfig
  config_context = var.context
}
