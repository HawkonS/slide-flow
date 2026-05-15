import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function PlaceholderPage({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {description ?? "此页面即将就绪。"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
