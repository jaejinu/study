# 2단계: 클러스터 위의 플랫폼 리소스를 코드로. 네임스페이스 + Redis(ConfigMap·Deployment·Service)
# k8s/redis.yaml(StatefulSet, kustomize) 의 Terraform 버전. 같은 리소스를 두 도구가 소유하면 안 되므로 네임스페이스를 분리했다.
resource "kubernetes_namespace_v1" "this" {
  metadata {
    name   = var.namespace
    labels = { "managed-by" = "opentofu", "pod-security.kubernetes.io/enforce" = "baseline" }
  }
}

resource "kubernetes_config_map_v1" "redis" {
  metadata {
    name      = "redis-config"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  data = {
    "redis.conf" = <<-CONF
      maxmemory ${var.redis_maxmemory}
      maxmemory-policy allkeys-lru
      appendonly no
      save ""
    CONF
  }
}

resource "kubernetes_deployment_v1" "redis" {
  metadata {
    name      = "redis"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
    labels    = { app = "redis" }
  }
  spec {
    replicas = 1
    selector { match_labels = { app = "redis" } }
    template {
      metadata {
        labels = { app = "redis" }
        # ConfigMap 이 바뀌면 Pod 를 재생성하도록 해시를 어노테이션에
        annotations = { "config-hash" = sha1(kubernetes_config_map_v1.redis.data["redis.conf"]) }
      }
      spec {
        security_context {
          run_as_non_root = true
          run_as_user     = 999
          fs_group        = 999
        }
        container {
          name  = "redis"
          image = var.redis_image
          args  = ["/etc/redis/redis.conf"]
          port { container_port = 6379 }
          volume_mount {
            name       = "config"
            mount_path = "/etc/redis"
            read_only  = true
          }
          resources {
            requests = { cpu = "50m", memory = "64Mi" }
            limits   = { memory = "128Mi" }
          }
          readiness_probe {
            exec { command = ["redis-cli", "ping"] }
            period_seconds = 2
          }
          security_context {
            allow_privilege_escalation = false
            capabilities { drop = ["ALL"] }
          }
        }
        volume {
          name = "config"
          config_map { name = kubernetes_config_map_v1.redis.metadata[0].name }
        }
      }
    }
  }
  wait_for_rollout = true
}

resource "kubernetes_service_v1" "redis" {
  metadata {
    name      = "redis"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  spec {
    selector = { app = "redis" }
    port {
      port        = 6379
      target_port = 6379
    }
  }
}

output "namespace" { value = kubernetes_namespace_v1.this.metadata[0].name }
output "redis_service" { value = "${kubernetes_service_v1.redis.metadata[0].name}.${var.namespace}.svc:6379" }
