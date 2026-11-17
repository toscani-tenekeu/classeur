<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AuthCard from '@/components/AuthCard.vue'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { signedIn } from '@/composables/useSession'
import { messageOf, post } from '@/lib/api'

const route = useRoute()
const router = useRouter()
const token = String(route.query.token ?? '')
const password = ref('')
const repeat = ref('')
const error = ref(token ? '' : 'Open the setup link exactly as it was printed when Classeur was installed.')
const busy = ref(false)

const mismatch = computed(() => repeat.value.length > 0 && repeat.value !== password.value)
const ready = computed(() => token && password.value.length >= 10 && repeat.value === password.value)

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await post('/setup', { token, password: password.value })
    signedIn.value = true
    await router.replace('/')
  } catch (failure) {
    error.value = messageOf(failure)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Set up Classeur" description="Choose the admin password. It replaces the one generated during installation.">
    <form @submit.prevent="submit">
      <FieldGroup>
        <Field>
          <FieldLabel for="new-password">Password</FieldLabel>
          <Input id="new-password" v-model="password" type="password" autocomplete="new-password" autofocus required minlength="10" />
          <FieldDescription>At least 10 characters.</FieldDescription>
        </Field>
        <Field :data-invalid="mismatch">
          <FieldLabel for="repeat-password">Repeat password</FieldLabel>
          <Input id="repeat-password" v-model="repeat" type="password" autocomplete="new-password" required :aria-invalid="mismatch" />
          <FieldError v-if="mismatch">The two passwords do not match.</FieldError>
        </Field>
        <FieldError v-if="error">{{ error }}</FieldError>
        <Button type="submit" :disabled="busy || !ready">
          <Spinner v-if="busy" />
          Save and continue
        </Button>
        <Button variant="link" as-child>
          <RouterLink to="/login">Sign in instead</RouterLink>
        </Button>
      </FieldGroup>
    </form>
  </AuthCard>
</template>
