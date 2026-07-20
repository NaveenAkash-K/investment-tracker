import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";

export default function ProtectedAppLayout({
                                               children,
                                           }: {
    children: React.ReactNode;
}) {
    return (
        <Suspense fallback={<ProtectedAppLoading />}>
            <ProtectedAppGate>{children}</ProtectedAppGate>
        </Suspense>
    );
}

async function ProtectedAppGate({
                                    children,
                                }: {
    children: React.ReactNode;
}) {
    const supabase = await createClient();

    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();

    if (error || !user) {
        redirect("/auth/login");
    }

    async function signOut() {
        "use server";

        const supabase = await createClient();
        await supabase.auth.signOut();

        redirect("/auth/login");
    }

    const { data: profile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("user_id", user.id)
        .maybeSingle();

    return (
        <AppShell
            displayName={profile?.display_name ?? ""}
            email={user.email ?? "Portfolio owner"}
            signOutAction={signOut}
        >
            {children}
        </AppShell>
    );
}

function ProtectedAppLoading() {
    return (
        <main className="min-h-screen bg-slate-50 px-4 py-24">
            <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-6 text-center">
                <p className="text-sm font-medium text-slate-700">
                    Loading your portfolio...
                </p>
            </div>
        </main>
    );
}
